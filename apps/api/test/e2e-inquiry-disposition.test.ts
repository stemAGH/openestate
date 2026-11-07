/**
 * Through-the-wire coverage for the Follow-Up Page spec's item #2 fix
 * (internal plan followup-spec-gap-analysis.md): Dump requires a reason
 * and remarks (SOP rule 5), enforced through the real ZodValidationPipe/
 * guard chain, not just the service.
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
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();
let phoneSeq = 0;
const nextPhone = () => `9${String(TAG).slice(-5)}${String(phoneSeq++).padStart(4, '0')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

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

function extractCookie(setCookieHeader: string[] | string | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  for (const h of headers) {
    const match = new RegExp(`${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  throw new Error(`Cookie ${name} not found in Set-Cookie headers`);
}

describeIf('e2e inquiry disposition: Dump requires reason and remarks', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let token: string;
  let csrf: string;
  let agent: ReturnType<typeof request.agent>;
  let dumpReasonId: string;

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
      data: { companyId: fx.companyId, name: 'E2E Dump Rep', slug: `e2e-dump-rep-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.PRESALES_INQUIRY_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_UPDATE,
        PERMISSIONS.ADMIN_MASTER_READ,
      ].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    const email = `e2e-dump-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Dump Rep',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

    const reason = await systemPrisma.dumpReason.create({
      data: { companyId: fx.companyId, name: 'Not interested', sortOrder: 0 },
    });
    dumpReasonId = reason.id;

    agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    csrf = extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf');
    token = loginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('refuses to dump without a reason and remarks, leaving the lead untouched', async () => {
    const created = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'No Reason Lead', primaryPhone: nextPhone() } })
      .expect(201);

    const rejectRes = await agent
      .patch(`/api/v1/inquiries/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'DUMPED' })
      .expect(400);
    expect(rejectRes.body.message).toMatch(/requires both a reason and remarks/i);

    const afterReject = await agent
      .get(`/api/v1/inquiries/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterReject.body.status).toBe('OPEN');
  });

  it('dumps successfully with reason+remarks, and the disposition history is queryable directly', async () => {
    const created = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'Proper Dump Lead', primaryPhone: nextPhone() } })
      .expect(201);

    const dumpRes = await agent
      .patch(`/api/v1/inquiries/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ status: 'DUMPED', dumpReasonId, dumpRemarks: 'Went with a competitor' })
      .expect(200);
    expect(dumpRes.body.status).toBe('DUMPED');

    const history = await systemPrisma.inquiryDispositionHistory.findMany({
      where: { inquiryId: created.body.id },
      orderBy: { changedAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[1].toStatus).toBe('DUMPED');
    expect(history[1].reasonId).toBe(dumpReasonId);
    expect(history[1].remarks).toBe('Went with a competitor');
  });
});
