/**
 * Through-the-wire coverage for GET /receipts/cheque-queue?status=.
 *
 * An unknown status (found in the v0.9.0 VM rehearsal: `?status=PENDING`)
 * used to reach Prisma unvalidated and come back as HTTP 500. It must be a 400
 * from the validation pipe, before the database is queried. Omitted, empty and
 * valid statuses keep their behaviour, as do the permission, tenant scoping and
 * the BOUNCED tab (which lists reversed receipts).
 *
 * Requires the compiled dist/ — see e2e-unit-pricing.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  makeUnit,
  makeApplicant,
  buildServices,
  cleanupCompany,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();
const L = (rupees: number) => BigInt(rupees) * 100n;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-cheque-queue-status-${process.pid}-${Date.now()}-`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handlerSpy: any;

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
  // Spied before the app is built, so the route is bound to the spy (which
  // calls through to the real handler). Nest keeps a route's metadata on the
  // method itself, so it is copied onto the spy or the route isn't registered.
  const { ReceiptController } = require('../dist/postsales/receipt.controller');
  const original = ReceiptController.prototype.chequeQueue;
  handlerSpy = vi.spyOn(ReceiptController.prototype, 'chequeQueue');
  for (const key of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), ReceiptController.prototype.chequeQueue);
  }
  const { AppModule } = require('../dist/app.module');
  // The production pipe (main.ts), so the 400 is the one users get.
  const { ZodValidationPipe } = require('../dist/common/pipes/zod-validation.pipe');
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

describeIf('e2e GET /receipts/cheque-queue?status=', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;
  let other: CompanyFixture;
  let receivedId: string;
  let bouncedId: string;
  let otherCompanyReceiptId: string;
  const emails = { verifier: '', none: '' };

  async function makeStaff(companyId: string, label: string, keys: string[]): Promise<string> {
    const perms = await systemPrisma.permission.findMany({ where: { key: { in: keys } } });
    expect(perms).toHaveLength(keys.length);
    const role = await systemPrisma.role.create({
      data: { companyId, name: `E2E ${label}`, slug: `e2e-cq-${label}-${TAG}`, isSystem: false },
    });
    await systemPrisma.rolePermission.createMany({
      data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
    const email = `e2e-cq-${label}-${TAG}@test.com`;
    await systemPrisma.user.create({
      data: {
        companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: `E2E ${label}`,
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    return email;
  }

  /** One cheque receipt on a fresh booking in the given company. */
  async function chequeReceipt(company: CompanyFixture, actorId: string): Promise<string> {
    const svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    const unitId = await makeUnit(systemPrisma, company);
    const applicantId = await makeApplicant(systemPrisma, company.companyId);
    const booking = await svc.bookings.createBooking(
      company.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: company.defaultGstRateId }],
      },
      actorId,
    );
    const plan = await svc.plans.createCustomPlan(
      company.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: booking.agreedPricePaise }] },
      actorId,
    );
    const receipt = await svc.receipts.createReceipt(
      company.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-20'),
        mode: 'CHEQUE',
        grossAmountPaise: L(1_00_000),
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(1_00_000) }],
        tdsDeductedPaise: 0n,
      },
      actorId,
    );
    return receipt.id;
  }

  async function login(email: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    const auth = { Authorization: `Bearer ${res.body.accessToken}`, 'X-CSRF-Token': extractCookie(res.headers['set-cookie'], 'openestate_csrf') };
    return { agent, auth };
  }

  const ids = (body: Array<{ id: string }>) => body.map((r) => r.id).sort();

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma, tenantPrisma } = makeClients());
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    fx = await seedCompany(systemPrisma);
    other = await seedCompany(systemPrisma);
    receivedId = await chequeReceipt(fx, fx.userId);
    bouncedId = await chequeReceipt(fx, fx.userId);
    await buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK).receipts.recordChequeEvent(
      fx.companyId,
      bouncedId,
      { status: 'BOUNCED', eventDate: new Date('2026-06-22'), reason: 'Insufficient funds' },
      fx.userId,
    );
    otherCompanyReceiptId = await chequeReceipt(other, other.userId);
    emails.verifier = await makeStaff(fx.companyId, 'verifier', [PERMISSIONS.POSTSALES_CHEQUE_VERIFY]);
    emails.none = await makeStaff(fx.companyId, 'none', [PERMISSIONS.POSTSALES_BOOKING_READ]);
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await cleanupCompany(systemPrisma, other.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('an unknown status is a 400 that names the field, and the database is never queried', async () => {
    const { agent, auth } = await login(emails.verifier);
    // The handler is the only place the cheque queue queries the database, so
    // "not called" means "never queried". The valid-status call is the control
    // that proves the spy sees real calls.
    handlerSpy.mockClear();
    for (const bad of ['PENDING', 'received', 'CLEARED ', 'NOT_A_STATUS']) {
      const res = await agent.get('/api/v1/receipts/cheque-queue').query({ status: bad }).set(auth);
      expect(res.status, `status=${JSON.stringify(bad)}`).toBe(400);
      // Names the field ("status", not just "statusCode").
      expect(JSON.stringify(res.body)).toMatch(/\bstatus\b(?!Code)/);
    }
    const repeated = await agent.get('/api/v1/receipts/cheque-queue?status=RECEIVED&status=BOUNCED').set(auth);
    expect(repeated.status).toBe(400);
    expect(handlerSpy).not.toHaveBeenCalled();

    await agent.get('/api/v1/receipts/cheque-queue').query({ status: 'RECEIVED' }).set(auth).expect(200);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it('omitted and empty status keep the default queue (RECEIVED and DEPOSITED, not reversed)', async () => {
    const { agent, auth } = await login(emails.verifier);
    const omitted = await agent.get('/api/v1/receipts/cheque-queue').set(auth).expect(200);
    const empty = await agent.get('/api/v1/receipts/cheque-queue?status=').set(auth).expect(200);
    expect(ids(omitted.body)).toEqual([receivedId]);
    expect(ids(empty.body)).toEqual(ids(omitted.body));
  });

  it('every valid status still works, and BOUNCED still lists the reversed receipt', async () => {
    const { agent, auth } = await login(emails.verifier);
    const by = async (status: string) =>
      ids((await agent.get('/api/v1/receipts/cheque-queue').query({ status }).set(auth).expect(200)).body);
    expect(await by('RECEIVED')).toEqual([receivedId]);
    expect(await by('BOUNCED')).toEqual([bouncedId]);
    expect(await by('DEPOSITED')).toEqual([]);
    expect(await by('CLEARED')).toEqual([]);
    expect(await by('NOT_APPLICABLE')).toEqual([]);
  });

  it('stays company-scoped: another company\'s cheque never appears', async () => {
    const { agent, auth } = await login(emails.verifier);
    for (const q of [{}, { status: 'RECEIVED' }]) {
      const res = await agent.get('/api/v1/receipts/cheque-queue').query(q).set(auth).expect(200);
      expect(ids(res.body)).not.toContain(otherCompanyReceiptId);
    }
  });

  it('still needs the cheque permission and a session, whatever the status', async () => {
    const { agent, auth } = await login(emails.none);
    await agent.get('/api/v1/receipts/cheque-queue').set(auth).expect(403);
    await agent.get('/api/v1/receipts/cheque-queue').query({ status: 'PENDING' }).set(auth).expect(403);
    await request(app.getHttpServer()).get('/api/v1/receipts/cheque-queue').query({ status: 'PENDING' }).expect(401);
  });
});
