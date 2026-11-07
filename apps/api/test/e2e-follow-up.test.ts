/**
 * Through-the-wire coverage for the Follow-Up Page spec's item #1 fix
 * (internal plan followup-spec-gap-analysis.md): nextActionAt required
 * while a lead is active (SOP rule 2), and interactionAt as a field
 * distinct from createdAt/nextActionAt (Collision 3). A direct-service
 * test can prove the service logic; only a real HTTP request proves the
 * ZodValidationPipe/guard chain actually delivers the 400 (or the 201)
 * the way a real client would see it, and that GET /inquiries/my-day
 * — which has never had a frontend caller before this fix — actually
 * reflects a follow-up logged through the real POST route.
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

describeIf('e2e follow-ups: nextActionAt required while active, interactionAt, My Day', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let token: string;
  let csrf: string;
  let agent: ReturnType<typeof request.agent>;

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
      data: { companyId: fx.companyId, name: 'E2E Follow-Up Rep', slug: `e2e-follow-up-rep-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.PRESALES_INQUIRY_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_UPDATE,
        PERMISSIONS.PRESALES_FOLLOW_UP_READ,
        PERMISSIONS.PRESALES_FOLLOW_UP_CREATE,
      ].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    const email = `e2e-follow-up-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Follow-Up Rep',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

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

  it('refuses to log a follow-up on an active lead with no nextActionAt, and requires nothing changes', async () => {
    const created = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'No Next Date', primaryPhone: nextPhone() } })
      .expect(201);

    const rejectRes = await agent
      .post(`/api/v1/inquiries/${created.body.id}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'Called, forgot to set a next date' })
      .expect(400);
    expect(rejectRes.body.message).toMatch(/next follow-up time is required/i);

    const timeline = await agent
      .get(`/api/v1/inquiries/${created.body.id}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(timeline.body).toHaveLength(0);
  });

  it('logs a follow-up with a backdated interactionAt and a future nextActionAt, and it appears distinctly in the timeline', async () => {
    const created = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'Backdated Call', primaryPhone: nextPhone() } })
      .expect(201);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const followUpRes = await agent
      .post(`/api/v1/inquiries/${created.body.id}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: "Logging yesterday's call", interactionAt: yesterday, nextActionAt: nextWeek })
      .expect(201);

    expect(new Date(followUpRes.body.interactionAt).toISOString()).toBe(new Date(yesterday).toISOString());
    // createdAt (row-insert time, "now") must not collapse onto the
    // backdated interactionAt — the entire point of the two being
    // separate columns.
    expect(new Date(followUpRes.body.createdAt).getTime()).toBeGreaterThan(new Date(yesterday).getTime());

    const inquiryRes = await agent
      .get(`/api/v1/inquiries/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(new Date(inquiryRes.body.nextFollowupAt).toISOString()).toBe(new Date(nextWeek).toISOString());
  });

  it('GET /inquiries/my-day reflects a follow-up logged through the real POST route (today and overdue, not future)', async () => {
    const dueToday = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'Due Today', primaryPhone: nextPhone() } })
      .expect(201);
    const overdue = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'Overdue', primaryPhone: nextPhone() } })
      .expect(201);
    const future = await agent
      .post('/api/v1/inquiries')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ applicant: { name: 'Future', primaryPhone: nextPhone() } })
      .expect(201);

    await agent
      .post(`/api/v1/inquiries/${dueToday.body.id}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'Due today', nextActionAt: new Date().toISOString() })
      .expect(201);
    await agent
      .post(`/api/v1/inquiries/${overdue.body.id}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'Overdue', nextActionAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })
      .expect(201);
    await agent
      .post(`/api/v1/inquiries/${future.body.id}/follow-ups`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ notes: 'Not yet', nextActionAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })
      .expect(201);

    const myDayRes = await agent
      .get('/api/v1/inquiries/my-day')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = (myDayRes.body as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(dueToday.body.id);
    expect(ids).toContain(overdue.body.id);
    expect(ids).not.toContain(future.body.id);
  });
});
