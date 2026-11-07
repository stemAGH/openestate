/**
 * Authorization regression tests: a portal session must never be able to
 * use a staff route, whatever permissions its role happens to hold.
 *
 * Suspected finding SF-01 (internal ui-audit-plan.md): the seeded
 * `broker` portal role holds `reports.broker.view`, which is the only
 * permission `BrokerReportsController` (reports/broker-reports.controller.ts)
 * checks, and `JwtStrategy` does not tell a portal token from a staff one.
 * If both hold, broker A can read company-wide broker reports, including
 * broker B's commission and customers.
 *
 * Part 2a only: a broker portal token against every /reports/brokers/*
 * route, plus a positive control proving each route answers a real staff
 * user holding exactly `reports.broker.view` — so a rejection here means
 * the boundary held, not that the route is broken.
 *
 * Same bootstrap as e2e-broker-portal.test.ts: real Express, real
 * APP_GUARD chain, real Postgres/Redis (the local test containers).
 * Needs the compiled dist/ (see that file's comment).
 *
 * Failure messages identify broker B's data by booleans and counts only —
 * never by printing names, phones or booking numbers.
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
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  COMMISSION_ENTRY_TYPE,
} from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  makeBroker,
  makePortalRole,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const shouldRun = !!(APP_URL && SYSTEM_URL);
const describeIf = shouldRun ? describe : describe.skip;

// Own throttle keyspace: this file makes one real portal login, and the
// portal-auth bucket (5 per 5 minutes per IP) is otherwise shared with
// every other e2e file running concurrently — same reasoning as
// e2e-broker-portal.test.ts.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-portal-token-boundary-${process.pid}-${Date.now()}-`;

const BROKER_PASSWORD = 'BrokerPass123';
const STAFF_PASSWORD = 'StaffPass123';

/** What we know about broker B, used only to detect B's data in a response. */
interface BrokerBMarkers {
  id: string;
  name: string;
  phone: string;
  bookingNumber: string;
}

/** Every string cell anywhere in a JSON body (report rows are string tuples). */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
  return out;
}

/**
 * Describes a response to a broker-A request without printing personal
 * data: status, row count, and whether any cell EXACTLY equals one of
 * broker B's identifiers (exact match, so "Broker 1" can't match "Broker 12").
 */
function describeLeak(status: number, body: unknown, b: BrokerBMarkers): string {
  const cells = new Set(allStrings(body));
  const rows = Array.isArray(body) ? body.length : body && typeof body === 'object' ? 'object' : 'none';
  return (
    `broker A's portal token got HTTP ${status} (expected 401/403). ` +
    `rows=${rows}; contains broker B's id=${cells.has(b.id)}, name=${cells.has(b.name)}, ` +
    `phone=${cells.has(b.phone)}, booking number=${cells.has(b.bookingNumber)}`
  );
}

describeIf('Portal/staff token boundary: broker portal token vs /reports/brokers/*', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let staffEmail: string;
  let brokerAPhone: string;
  let brokerB: BrokerBMarkers;

  let brokerAToken: string;
  let staffToken: string;

  /** The five routes in broker-reports.controller.ts:33-77. Built lazily
   * because customer-detail needs broker B's id. */
  const routes = (): Array<{ name: string; path: string }> => [
    { name: 'sold-units (all brokers)', path: '/api/v1/reports/brokers/sold-units' },
    { name: 'commission-summary', path: '/api/v1/reports/brokers/commission-summary' },
    { name: 'dues', path: '/api/v1/reports/brokers/dues' },
    { name: 'summary', path: '/api/v1/reports/brokers/summary' },
    { name: "customer-detail (broker B's id)", path: `/api/v1/reports/brokers/${brokerB.id}/customer-detail` },
  ];

  beforeAll(async () => {
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
    app = nestApp;

    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    // Broker portal role with exactly the seeded broker permissions.
    const brokerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'broker');
    await systemPrisma.rolePermission.createMany({
      data: ROLE_PERMISSIONS[SYSTEM_ROLES.BROKER]
        .map((key) => permByKey.get(key))
        .filter((id): id is string => !!id)
        .map((permissionId) => ({ roleId: brokerRoleId, permissionId })),
    });

    // This test checks the portal/staff TOKEN boundary, independently of
    // which permissions a portal role holds. So the broker role is made to
    // hold reports.broker.view here whether or not the seed grants it.
    // Removing the permission from the broker role must NOT be considered
    // a fix for SF-01: an admin can grant it again in the Roles screen, and
    // a portal token would then reach the staff routes again.
    const reportPermId = permByKey.get(PERMISSIONS.REPORTS_BROKER_VIEW);
    await systemPrisma.rolePermission.createMany({
      data: [{ roleId: brokerRoleId, permissionId: reportPermId }],
      skipDuplicates: true,
    });
    const held = await systemPrisma.rolePermission.findFirst({
      where: { roleId: brokerRoleId, permissionId: reportPermId },
    });
    if (!held) {
      throw new Error('Test premise failed: the broker portal role does not hold reports.broker.view');
    }

    // Positive control: a STAFF role holding ONLY reports.broker.view — the
    // same single permission the broker role holds. isPortal is set
    // explicitly rather than left to the column default.
    const tag = Date.now();
    const staffRole = await systemPrisma.role.create({
      data: {
        companyId: fx.companyId,
        name: 'E2E Broker Report Viewer',
        slug: `e2e-broker-report-viewer-${tag}`,
        isPortal: false,
      },
    });
    await systemPrisma.rolePermission.create({
      data: { roleId: staffRole.id, permissionId: permByKey.get(PERMISSIONS.REPORTS_BROKER_VIEW) },
    });
    staffEmail = `e2e-token-boundary-staff-${tag}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: staffEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Report Viewer',
        roleId: staffRole.id,
        forcePasswordChange: false,
      },
    });

    // Two brokers, each with a portal user, a booking and a commission accrual.
    const brokerAId = await makeBroker(systemPrisma, fx.companyId);
    const brokerBId = await makeBroker(systemPrisma, fx.companyId);

    for (const [brokerId, suffix] of [[brokerAId, 'A'], [brokerBId, 'B']] as const) {
      const broker = await systemPrisma.broker.findUniqueOrThrow({ where: { id: brokerId } });
      await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          brokerId,
          phone: broker.phone,
          name: broker.name,
          passwordHash: await argon2.hash(BROKER_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
          roleId: brokerRoleId,
          forcePasswordChange: false,
        },
      });

      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const unitId = await makeUnit(systemPrisma, fx);
      const bookingNumber = `E2ETB-${suffix}-${tag}`;
      const booking = await systemPrisma.booking.create({
        data: {
          companyId: fx.companyId,
          unitId,
          primaryApplicantId: applicantId,
          bookingNumber,
          agreedPricePaise: BigInt(20_00_000_00),
          bookingDate: new Date('2026-06-01'),
          brokerId,
        },
      });

      await systemPrisma.commissionLedgerEntry.create({
        data: {
          companyId: fx.companyId,
          brokerId,
          bookingId: booking.id,
          entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
          signedAmountPaise: BigInt(50_000_00),
          effectiveDate: new Date('2026-06-15'),
        },
      });

      if (suffix === 'A') brokerAPhone = broker.phone;
      else brokerB = { id: brokerId, name: broker.name, phone: broker.phone, bookingNumber };
    }

    // One real portal login for broker A, one real staff login.
    const portalRes = await request(app.getHttpServer())
      .post('/api/v1/portal/auth/login')
      .send({ identifier: brokerAPhone, password: BROKER_PASSWORD })
      .expect(200);
    brokerAToken = portalRes.body.accessToken as string;

    const staffRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: STAFF_PASSWORD })
      .expect(200);
    staffToken = staffRes.body.accessToken as string;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('positive control: a staff user holding only reports.broker.view gets 200 on every route, and sees broker B', async () => {
    for (const r of routes()) {
      const res = await request(app.getHttpServer())
        .get(r.path)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(res.status, `staff control on ${r.name}`).toBe(200);
    }

    // The control must be able to SEE broker B, otherwise "B absent" in a
    // leaking response would prove nothing. Checked on the row reports.
    const summary = await request(app.getHttpServer())
      .get('/api/v1/reports/brokers/commission-summary')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    expect(new Set(allStrings(summary.body)).has(brokerB.name), 'staff control sees broker B in commission-summary').toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/reports/brokers/${brokerB.id}/customer-detail`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    expect(new Set(allStrings(detail.body)).has(brokerB.bookingNumber), "staff control sees broker B's booking in customer-detail").toBe(true);
  });

  it("control: broker A's portal token is a working session (its own portal dashboard answers 200)", async () => {
    await request(app.getHttpServer())
      .get('/api/v1/portal/broker/dashboard')
      .set('Authorization', `Bearer ${brokerAToken}`)
      .expect(200);
  });

  // One test per route so each leak is reported separately.
  for (const name of [
    'sold-units (all brokers)',
    'commission-summary',
    'dues',
    'summary',
    "customer-detail (broker B's id)",
  ]) {
    it(`broker A's portal token is rejected by staff route: ${name}`, async () => {
      const r = routes().find((x) => x.name === name)!;
      const res = await request(app.getHttpServer())
        .get(r.path)
        .set('Authorization', `Bearer ${brokerAToken}`);
      expect([401, 403], describeLeak(res.status, res.body, brokerB)).toContain(res.status);
    });
  }
});
