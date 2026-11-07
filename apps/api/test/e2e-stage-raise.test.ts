/**
 * Through-the-wire HTTP coverage for the new StageRaiseController
 * (internal plan construction-linked-demand-fix.md) — per this codebase's
 * standing rule that a new controller needs at least one real-HTTP test,
 * not just direct-service-call tests, to prove the route is actually
 * registered and the guard chain (permission guard, CSRF on POST) gates it.
 *
 * Requires the compiled dist/ — see e2e-unit-pricing.test.ts for why.
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
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, makeUnit, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

// Private throttle keyspace for this file, set BEFORE the app bootstraps
// so RedisThrottlerStorage picks it up — see e2e-dashboard-hierarchy.test.ts's
// identical comment and CLAUDE.md's Phase 8 entry: the default bucket is
// IP-keyed (100/min) and every e2e file shares one loopback IP and one
// Redis, so an unprefixed file's logins can push an already-near-limit
// shared bucket over and cause UNRELATED files to 429.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-stage-raise-${process.pid}-${Date.now()}-`;

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

describeIf('e2e /projects/:projectId/stage-raises', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let adminEmail: string;
  let noPermEmail: string;
  let templateId: string;
  let bookingId: string;
  let stageInstallmentId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Stage Raise Admin', slug: `e2e-stage-raise-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.POSTSALES_DEMAND_RAISE].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });
    const noPermRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E No Perm', slug: `e2e-no-perm-${TAG}`, isSystem: true },
    });

    adminEmail = `e2e-stage-raise-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: adminEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Stage Raise Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    noPermEmail = `e2e-no-perm-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: noPermEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E No Perm',
        roleId: noPermRole.id,
        forcePasswordChange: false,
      },
    });

    const template = await systemPrisma.paymentPlanTemplate.create({
      data: { companyId: fx.companyId, name: `E2E Stage Template ${TAG}` },
    });
    templateId = template.id;
    await systemPrisma.paymentPlanMilestone.create({
      data: { companyId: fx.companyId, templateId, seq: 1, label: 'On Booking', percent: 40, milestoneType: 'DATE_LINKED', dueOffsetDays: 0 },
    });
    await systemPrisma.paymentPlanMilestone.create({
      data: { companyId: fx.companyId, templateId, seq: 2, label: 'Superstructure', percent: 60, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 10 },
    });

    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber: `E2E-STAGE-${TAG}`,
        agreedPricePaise: 10_00_000n * 100n,
        bookingDate: new Date('2027-01-01'),
        placeOfSupplyStateCode: '09',
      },
    });
    bookingId = booking.id;
    const plan = await systemPrisma.paymentPlan.create({
      data: { companyId: fx.companyId, bookingId, templateId, name: template.name, isCustom: false, version: 1 },
    });
    await systemPrisma.installment.create({
      data: { companyId: fx.companyId, bookingId, planId: plan.id, seq: 1, label: 'On Booking', milestoneType: 'DATE_LINKED', milestoneSeq: 1, dueDate: new Date('2027-01-01'), amountPaise: 4_00_000n * 100n, milestonePercent: 40 },
    });
    const stageInst = await systemPrisma.installment.create({
      data: { companyId: fx.companyId, bookingId, planId: plan.id, seq: 2, label: 'Superstructure', milestoneType: 'STAGE_LINKED', milestoneSeq: 2, dueDate: null, amountPaise: 6_00_000n * 100n, milestonePercent: 60 },
    });
    stageInstallmentId = stageInst.id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
    for (const h of headers) {
      const match = new RegExp(`${name}=([^;]+)`).exec(h);
      if (match) return match[1];
    }
    throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
  }

  async function login(email: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    return { agent, csrf: extractCookie(res.headers['set-cookie'], 'openestate_csrf'), token: res.body.accessToken as string };
  }

  it('lists the pending stage, raises it over real HTTP, and the installment is updated', async () => {
    const { agent, csrf, token } = await login(adminEmail);
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };

    const pendingRes = await agent.get(`/api/v1/projects/${fx.projectId}/stage-raises/pending`).set(auth).expect(200);
    expect(pendingRes.body).toHaveLength(1);
    expect(pendingRes.body[0]).toMatchObject({ templateId, milestoneSeq: 2, label: 'Superstructure', pendingCount: 1 });

    const raiseRes = await agent
      .post(`/api/v1/projects/${fx.projectId}/stage-raises`)
      .set(auth)
      .send({ templateId, milestoneSeq: 2, stageCompletedOn: '2027-06-01' })
      .expect(201);
    expect(raiseRes.body.raisedCount).toBe(1);

    const installment = await systemPrisma.installment.findUnique({ where: { id: stageInstallmentId } });
    expect(installment.dueDate.toISOString().slice(0, 10)).toBe('2027-06-11'); // +10 grace days

    const pendingAfter = await agent.get(`/api/v1/projects/${fx.projectId}/stage-raises/pending`).set(auth).expect(200);
    expect(pendingAfter.body).toHaveLength(0);
  });

  it('403s for a staff user without POSTSALES_DEMAND_RAISE', async () => {
    const { agent, csrf, token } = await login(noPermEmail);
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };
    await agent
      .post(`/api/v1/projects/${fx.projectId}/stage-raises`)
      .set(auth)
      .send({ templateId, milestoneSeq: 2, stageCompletedOn: '2027-06-01' })
      .expect(403);
  });

  it('404s for a project belonging to a different company', async () => {
    const { agent, csrf, token } = await login(adminEmail);
    const auth = { Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf };
    const otherFx = await seedCompany(systemPrisma);
    try {
      await agent
        .post(`/api/v1/projects/${otherFx.projectId}/stage-raises`)
        .set(auth)
        .send({ templateId, milestoneSeq: 2, stageCompletedOn: '2027-06-01' })
        .expect(404);
    } finally {
      await cleanupCompany(systemPrisma, otherFx.companyId);
    }
  });
});
