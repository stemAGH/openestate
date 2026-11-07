/**
 * Through-the-wire HTTP coverage for POST /bookings/:id/source-inquiry
 * (Booking.sourceInquiryId — item 3 of the Follow-Up Page spec work,
 * internal plan followup-spec-gap-analysis.md): proves the real route is
 * registered, gated by POSTSALES_BOOKING_CREATE, and that the inquiry
 * actually flips to SUCCESSFUL over a real request — the same "a
 * controller-method-direct-call test proves the handler, not that the
 * route exists" lesson CLAUDE.md's Phase 5 decisions already established.
 * booking-source-inquiry.test.ts covers the business logic directly.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
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
import { makeClients, seedCompany, makeUnit, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

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

describeIf('e2e POST /bookings/:id/source-inquiry', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let agent: ReturnType<typeof request.agent>;
  let auth: Record<string, string>;
  let readOnlyAgent: ReturnType<typeof request.agent>;
  let readOnlyAuth: Record<string, string>;
  let gstRateId: string;

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
      data: { companyId: fx.companyId, name: 'E2E Source Inquiry Admin', slug: `e2e-src-inq-admin-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [
        PERMISSIONS.PRESALES_APPLICANT_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_CREATE,
        PERMISSIONS.PRESALES_INQUIRY_READ,
        PERMISSIONS.PRESALES_INQUIRY_UPDATE,
        PERMISSIONS.POSTSALES_BOOKING_CREATE,
      ].map((key) => ({ roleId: role.id, permissionId: permByKey.get(key) })),
    });

    const readOnlyRole = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Source Inquiry Read Only', slug: `e2e-src-inq-ro-${TAG}`, isSystem: true },
    });
    await systemPrisma.rolePermission.createMany({
      data: [PERMISSIONS.PRESALES_INQUIRY_READ].map((key) => ({
        roleId: readOnlyRole.id,
        permissionId: permByKey.get(key),
      })),
    });

    const email = `e2e-src-inq-admin-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Source Inquiry Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    const readOnlyEmail = `e2e-src-inq-ro-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email: readOnlyEmail,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Source Inquiry Read Only',
        roleId: readOnlyRole.id,
        forcePasswordChange: false,
      },
    });

    agent = request.agent(app.getHttpServer());
    const loginRes = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    auth = {
      Authorization: `Bearer ${loginRes.body.accessToken as string}`,
      'X-CSRF-Token': extractCookie(loginRes.headers['set-cookie'], 'openestate_csrf'),
    };

    readOnlyAgent = request.agent(app.getHttpServer());
    const roLoginRes = await readOnlyAgent
      .post('/api/v1/auth/login')
      .send({ email: readOnlyEmail, password: STAFF_PASSWORD })
      .expect(200);
    readOnlyAuth = {
      Authorization: `Bearer ${roLoginRes.body.accessToken as string}`,
      'X-CSRF-Token': extractCookie(roLoginRes.headers['set-cookie'], 'openestate_csrf'),
    };

    const gr = await systemPrisma.gstRate.create({
      data: { companyId: fx.companyId, rate: 5, description: `GST 5% ${TAG}`, effectiveFrom: new Date('2019-04-01') },
    });
    gstRateId = gr.id;
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  async function createApplicant(): Promise<string> {
    const res = await agent
      .post('/api/v1/applicants')
      .set(auth)
      .send({ name: 'E2E Source Inquiry Applicant', primaryPhone: nextPhone(), alternatePhones: [] })
      .expect(201);
    return (res.body.applicant ?? res.body).id as string;
  }

  async function createInquiry(applicantId: string): Promise<string> {
    const res = await agent.post('/api/v1/inquiries').set(auth).send({ applicantId }).expect(201);
    return res.body.id as string;
  }

  async function createBooking(applicantId: string): Promise<string> {
    const unitId = await makeUnit(systemPrisma, fx);
    const res = await agent
      .post('/api/v1/bookings')
      .set(auth)
      .send({
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: '2026-06-01',
        costLines: [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: '5000000000', gstRateId }],
      })
      .expect(201);
    return res.body.id as string;
  }

  it('links the booking, flips the inquiry to SUCCESSFUL, and the link is readable back over HTTP', async () => {
    const applicantId = await createApplicant();
    const inquiryId = await createInquiry(applicantId);
    const bookingId = await createBooking(applicantId);

    const res = await agent
      .post(`/api/v1/bookings/${bookingId}/source-inquiry`)
      .set(auth)
      .send({ inquiryId })
      .expect(201);
    expect(res.body.sourceInquiryId).toBe(inquiryId);

    const inquiryRes = await agent.get(`/api/v1/inquiries/${inquiryId}`).set(auth).expect(200);
    expect(inquiryRes.body.status).toBe('SUCCESSFUL');
  });

  it('rejects linking to a DUMPED inquiry with a clear message', async () => {
    const applicantId = await createApplicant();
    const inquiryId = await createInquiry(applicantId);
    const dumpReason = await systemPrisma.dumpReason.create({
      data: { companyId: fx.companyId, name: `E2E Src Inq Dump Reason ${TAG}`, sortOrder: 0 },
    });
    await agent
      .patch(`/api/v1/inquiries/${inquiryId}`)
      .set(auth)
      .send({ status: 'DUMPED', dumpReasonId: dumpReason.id, dumpRemarks: 'No longer interested' })
      .expect(200);
    const bookingId = await createBooking(applicantId);

    const res = await agent
      .post(`/api/v1/bookings/${bookingId}/source-inquiry`)
      .set(auth)
      .send({ inquiryId })
      .expect(400);
    expect(res.body.message).toMatch(/dumped lead/i);
  });

  it('403s for a caller without postsales.booking.create', async () => {
    const applicantId = await createApplicant();
    const inquiryId = await createInquiry(applicantId);
    const bookingId = await createBooking(applicantId);

    await readOnlyAgent
      .post(`/api/v1/bookings/${bookingId}/source-inquiry`)
      .set(readOnlyAuth)
      .send({ inquiryId })
      .expect(403);
  });
});
