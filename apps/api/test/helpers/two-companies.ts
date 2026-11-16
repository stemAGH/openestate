/**
 * Two companies (A and B) with one row of each kind a request can name, and
 * an all-permissions staff session in company A, for the tenant-ownership
 * tests: each case sends a valid request from A with one id taken from B.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
 */
import { expect } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, makeUnit, makeApplicant, makeBroker, type CompanyFixture } from './postsales-harness';
import { crossCompanyReferences } from '../../../../packages/db/prisma/sync-permissions';

export type Rows = {
  fx: CompanyFixture; user: string; unit: string; applicant: string; broker: string; source: string; inquiryType: string;
  temperature: string; followUpType: string; unitType: string; projectType: string; plcType: string; chargeType: string;
  bank: string; receiptType: string;
};

export interface TwoCompanies {
  app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemPrisma: any;
  A: Rows;
  B: Rows;
  tag: string;
  /** Company A's own inquiry, booking (with one installment) and inbound-lead API key. */
  own: { inquiry: string; booking: string; installment: string; leadKey: string };
  send: (method: 'get' | 'post' | 'patch' | 'put', url: string, body?: unknown) => request.Test;
  /** A 404 whose message names the refused field. */
  refused: (res: request.Response, field: RegExp) => void;
  /** Stored references from company A's rows to another company's rows (the upgrade report). */
  crossReferencesOfA: () => Promise<Array<{ column: string; count: number }>>;
  cleanup: () => Promise<void>;
}

export async function bootstrapApp(): Promise<INestApplication> {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.DATABASE_URL_SYSTEM = process.env.DATABASE_URL_TEST_SYSTEM;
  process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-test-refresh-secret-0123456789';
  process.env.PAN_ENCRYPTION_KEY ??= 'a1b2c3d4'.repeat(8);
  process.env.TOTP_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);
  process.env.PLUGIN_SECRET_ENCRYPTION_KEYS ??= `1:${'c9d8e7f6'.repeat(8)}`;
  process.env.CORS_ALLOWLIST ??= 'http://localhost:5174';
  process.env.SWAGGER_ENABLED = 'false';
  const require = createRequire(import.meta.url);
  const { AppModule } = require('../../dist/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const nestApp = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

export async function setupTwoCompanies(tag: string): Promise<TwoCompanies> {
  const app = await bootstrapApp();
  const { systemPrisma } = makeClients();
  const rows = async (fx: CompanyFixture): Promise<Rows> => {
    const c = { companyId: fx.companyId };
    const t = `${tag}-${fx.companyId.slice(0, 6)}`;
    return {
      fx,
      user: fx.userId,
      unit: await makeUnit(systemPrisma, fx),
      applicant: await makeApplicant(systemPrisma, fx.companyId),
      broker: await makeBroker(systemPrisma, fx.companyId),
      source: (await systemPrisma.inquirySource.create({ data: { ...c, name: `Src ${t}` } })).id,
      inquiryType: (await systemPrisma.inquiryType.create({ data: { ...c, name: `Type ${t}` } })).id,
      temperature: (await systemPrisma.inquiryTemperature.create({ data: { ...c, name: `Temp ${t}` } })).id,
      followUpType: (await systemPrisma.followUpType.create({ data: { ...c, name: `FU ${t}` } })).id,
      unitType: (await systemPrisma.unitType.create({ data: { ...c, name: `UT ${t}` } })).id,
      projectType: (await systemPrisma.projectType.create({ data: { ...c, name: `PT ${t}` } })).id,
      plcType: (await systemPrisma.plcType.create({ data: { ...c, name: `PLC ${t}` } })).id,
      chargeType: (await systemPrisma.chargeType.create({ data: { ...c, name: `CT ${t}` } })).id,
      bank: (await systemPrisma.bank.create({ data: { ...c, name: `Bank ${t}` } })).id,
      receiptType: (await systemPrisma.receiptType.create({ data: { ...c, name: `RT ${t}` } })).id,
    };
  };
  const A = await rows(await seedCompany(systemPrisma));
  const B = await rows(await seedCompany(systemPrisma));

  for (const key of ALL_PERMISSIONS) await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  const perms = await systemPrisma.permission.findMany();
  const role = await systemPrisma.role.create({ data: { companyId: A.fx.companyId, name: `All ${tag}`, slug: `all-${tag}` } });
  await systemPrisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
  const email = `e2e-tenant-${tag}@test.com`;
  const password = 'StaffPass123';
  const hash = await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id });
  await systemPrisma.user.create({ data: { companyId: A.fx.companyId, email, name: 'Tenant A Admin', passwordHash: hash, roleId: role.id, forcePasswordChange: false } });
  const agent = request.agent(app.getHttpServer());
  const login = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
  const token = login.body.accessToken;
  const csrf = /openestate_csrf=([^;]+)/.exec(([] as string[]).concat(login.headers['set-cookie'] ?? []).join(';'))![1];
  const send = (method: 'get' | 'post' | 'patch' | 'put', url: string, body?: unknown) => {
    const r = agent[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body as object);
  };

  const inq = await send('post', '/inquiries', { applicant: { name: 'A Lead', primaryPhone: '9811177701' }, projectId: A.fx.projectId });
  expect(inq.status, JSON.stringify(inq.body)).toBe(201);
  const costLines = [{ kind: 'BASE', label: 'Base', baseAmountPaise: '100000', gstRateId: A.fx.defaultGstRateId }];
  const quote = await send('post', '/bookings/quote', { unitId: A.unit, costLines });
  expect(quote.status, JSON.stringify(quote.body)).toBe(201);
  const booked = await send('post', '/bookings/with-plan', {
    unitId: A.unit, primaryApplicantId: A.applicant, coApplicantIds: [], bookingDate: '2026-11-12', costLines,
    expectedAgreedPricePaise: quote.body.agreedPricePaise,
    plan: { mode: 'custom', name: 'Custom Plan', installments: [{ label: 'All', dueDate: '2026-12-01', amountPaise: quote.body.agreedPricePaise }] },
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const key = await send('post', '/admin/lead-api-keys', { name: `Key ${tag}`, fieldMapping: { name: 'n', phone: 'p', projectId: 'project' } });
  expect(key.status, JSON.stringify(key.body)).toBe(201);

  return {
    app, systemPrisma, A, B, tag, send,
    own: { inquiry: inq.body.id, booking: booked.body.booking.id, installment: booked.body.plan.installments[0].id, leadKey: key.body.rawKey },
    refused: (res, field) => {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(String(res.body.message)).toMatch(field);
    },
    crossReferencesOfA: async () => (await crossCompanyReferences(systemPrisma, { companyId: A.fx.companyId }))[0]?.columns ?? [],
    cleanup: async () => {
      for (const r of [A, B]) await cleanupCompany(systemPrisma, r.fx.companyId);
      await systemPrisma.$disconnect();
      await app.close();
    },
  };
}
