/**
 * Regression coverage for the crash bug found while auditing the 35
 * "coupling sites" §13.1 flagged for plotted-farmhouse-inventory Phase B:
 * PortalPropertyService.getMyProperties() read
 * `b.unit.floor.tower.project.id`/`.name`/etc. with no null check —
 * `floor` is null for a LAND_BASED unit (Phase A), so a customer whose
 * booking is against a floorless unit got a raw 500 on their own
 * property page, not a degraded page. See
 * internal plan plotted-farmhouse-inventory.md §13.1 for the full
 * breakdown of what else this audit found and fixed vs. deliberately
 * left alone.
 *
 * Through-the-wire (not a direct service call) because the bug is in
 * how the service assembles its response, and only a real HTTP round
 * trip proves the JSON actually serializes without throwing.
 *
 * Requires the compiled dist/ — see e2e-stage-raise.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, makeUnit, makeApplicant, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const CUSTOMER_PASSWORD = 'CustomerPass123';
const TAG = Date.now();

// Private throttle keyspace for this file — see e2e-dashboard-hierarchy
// .test.ts's identical comment and CLAUDE.md's Phase 8 entry.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-land-based-property-${process.pid}-${Date.now()}-`;

async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = APP_URL;
  process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
  process.env.SWAGGER_ENABLED = 'false';

  const require = createRequire(import.meta.url);
  const { AppModule } = require('../dist/app.module');

  const nestApp = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  nestApp.use(helmet());
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

describeIf('e2e GET /portal/property — LAND_BASED (floorless) unit', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let customerPhone: string;
  let landProjectId: string;
  let landUnitNumber: string;
  let highRiseUnitNumber: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));
    const customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await systemPrisma.rolePermission.createMany({
      data: ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]
        .map((key) => permByKey.get(key))
        .filter((id: string | undefined): id is string => !!id)
        .map((permissionId: string) => ({ roleId: customerRoleId, permissionId })),
    });

    // A second, LAND_BASED project — Project.shape is immutable per
    // §13.3, so this can't be the same project seedCompany() already
    // created (that one defaults to HIGH_RISE).
    const landProject = await systemPrisma.project.create({
      data: {
        companyId: fx.companyId,
        name: `Land Project ${TAG}`,
        code: `LP-${TAG}`,
        shape: 'LAND_BASED',
        // Phase D: the portal displays land area in THIS unit, not the
        // unit's own entered unit below (ACRE) — deliberately different
        // so the assertion can't pass by coincidence.
        landAreaDefaultUnit: 'GUNTA',
      },
    });
    landProjectId = landProject.id;
    landUnitNumber = `PLOT-${TAG}`;
    const landUnit = await systemPrisma.unit.create({
      data: {
        companyId: fx.companyId,
        projectId: landProjectId,
        shape: 'LAND_BASED',
        floorId: null,
        number: landUnitNumber,
        status: 'AVAILABLE',
        landAreaEntered: 0.5,
        landAreaEnteredUnit: 'ACRE',
        // 0.5 acre = 21,780 sqft exactly (43,560 sqft/acre ÷ 2).
        landAreaSqft: 21780,
      },
    });

    const highRiseUnitId = await makeUnit(systemPrisma, fx);
    const highRiseUnit = await systemPrisma.unit.findUniqueOrThrow({ where: { id: highRiseUnitId } });
    highRiseUnitNumber = highRiseUnit.number;

    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const applicant = await systemPrisma.applicant.findUniqueOrThrow({ where: { id: applicantId } });
    customerPhone = applicant.primaryPhone;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        applicantId,
        phone: customerPhone,
        name: applicant.name,
        passwordHash: await argon2.hash(CUSTOMER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        roleId: customerRoleId,
        forcePasswordChange: false,
      },
    });

    await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: landUnit.id,
        primaryApplicantId: applicantId,
        bookingNumber: `LAND-${TAG}`,
        agreedPricePaise: BigInt(15_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });
    await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: highRiseUnitId,
        primaryApplicantId: applicantId,
        bookingNumber: `HR-${TAG}`,
        agreedPricePaise: BigInt(20_00_000_00),
        bookingDate: new Date('2026-06-01'),
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (fx?.companyId) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await app?.close();
  });

  it('returns 200 with tower/floor null for the LAND_BASED booking, and unchanged for the HIGH_RISE one', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: customerPhone, password: CUSTOMER_PASSWORD })
      .expect(200);
    const token = login.body.accessToken as string;
    expect(token).toBeTruthy();

    const res = await request(app.getHttpServer())
      .get('/api/v1/portal/property')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const properties = res.body as Array<{
      bookingNumber: string;
      tower: { name: string } | null;
      floor: { name: string } | null;
      unit: { number: string; landAreaSqft: string | null };
      project: { id: string; landAreaDefaultUnit: string | null };
    }>;

    const landEntry = properties.find((p) => p.bookingNumber === `LAND-${TAG}`);
    expect(landEntry).toBeDefined();
    expect(landEntry!.tower).toBeNull();
    expect(landEntry!.floor).toBeNull();
    expect(landEntry!.unit.number).toBe(landUnitNumber);
    expect(landEntry!.project.id).toBe(landProjectId);
    // Phase D: landAreaSqft and the project's landAreaDefaultUnit are
    // both exposed so Property.tsx can display in the project's unit,
    // not the plot's own entered unit.
    expect(Number(landEntry!.unit.landAreaSqft)).toBe(21780);
    expect(landEntry!.project.landAreaDefaultUnit).toBe('GUNTA');

    const hrEntry = properties.find((p) => p.bookingNumber === `HR-${TAG}`);
    expect(hrEntry).toBeDefined();
    expect(hrEntry!.tower).not.toBeNull();
    expect(hrEntry!.floor).not.toBeNull();
    expect(hrEntry!.unit.number).toBe(highRiseUnitNumber);
  });
});
