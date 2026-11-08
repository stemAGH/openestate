/**
 * Restricted identifier fields (the encrypted value and its key version)
 * never leave the server: no API response carries them, new audit snapshots
 * don't store them, and audit rows stored earlier have them dropped on the
 * way out. Only the masked value is shown.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PASSWORD = 'StaffPass123';
const TAG = `${Date.now()}-${process.pid}`;
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-identifier-fields-${TAG}-`;
const PAN = 'ABCDE1234F';
const PAN2 = 'PQRST6789Z';
const digits = (n: number) => `9${String(Date.now() + n).slice(-9)}`;

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
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

describeIf('e2e restricted identifier fields never leave the server', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  const ids: Record<string, string> = {};
  let token = '';
  let csrf = { token: '', cookie: '' };
  const ciphertexts: string[] = [];

  const send = (method: 'get' | 'post' | 'patch', path: string, body?: object) => {
    let r = request(app.getHttpServer())[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    if (method !== 'get') r = r.set('X-CSRF-Token', csrf.token).set('Cookie', csrf.cookie).send(body ?? {});
    return r;
  };

  /** No restricted field name and no stored ciphertext value anywhere in the body. */
  function expectClean(text: string) {
    for (const f of ['panCiphertext', 'panKeyVersion', 'pan_ciphertext', 'pan_key_version']) expect(text, f).not.toContain(f);
    for (const c of ciphertexts) expect(text).not.toContain(c);
  }

  async function rememberCiphertexts() {
    const rows = [
      ...(await systemPrisma.applicant.findMany({ where: { companyId: fx.companyId, panCiphertext: { not: null } }, select: { panCiphertext: true } })),
      ...(await systemPrisma.broker.findMany({ where: { companyId: fx.companyId, panCiphertext: { not: null } }, select: { panCiphertext: true } })),
    ];
    for (const r of rows) if (!ciphertexts.includes(r.panCiphertext)) ciphertexts.push(r.panCiphertext);
  }

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    for (const key of ALL_PERMISSIONS) await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    const permByKey = new Map((await systemPrisma.permission.findMany()).map((p: { key: string; id: string }) => [p.key, p.id]));
    const role = await systemPrisma.role.create({ data: { companyId: fx.companyId, name: `Admin ${TAG}`, slug: SYSTEM_ROLES.COMPANY_ADMIN } });
    await systemPrisma.rolePermission.createMany({
      data: ROLE_PERMISSIONS[SYSTEM_ROLES.COMPANY_ADMIN].map((k) => ({ roleId: role.id, permissionId: permByKey.get(k) })),
    });
    const email = `e2e-idf-${TAG}@test.com`;
    ids.admin = (await systemPrisma.user.create({
      data: { companyId: fx.companyId, email, name: 'IDF Admin', roleId: role.id, forcePasswordChange: false, passwordHash: await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id }) },
    })).id;
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    token = res.body.accessToken;
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    csrf = { token: /openestate_csrf=([^;]+)/.exec(cookies.join(';'))?.[1] ?? '', cookie: cookies.map((c) => c.split(';')[0]).join('; ') };
  });

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  it('POST /applicants returns only the masked value', async () => {
    const res = await send('post', '/applicants', { name: `IDF A ${TAG}`, primaryPhone: digits(1), pan: PAN });
    expect(res.status, res.text).toBe(201);
    ids.applicant = res.body.id ?? res.body.applicant?.id;
    expect(res.text).toContain('panMasked');
    await rememberCiphertexts();
    expect(ciphertexts.length).toBeGreaterThan(0);
    expectClean(res.text);
  });

  it('PATCH /applicants/:id returns only the masked value', async () => {
    const res = await send('patch', `/applicants/${ids.applicant}`, { pan: PAN2 });
    expect(res.status, res.text).toBe(200);
    await rememberCiphertexts();
    expectClean(res.text);
  });

  it('GET /applicants/:id/360', async () => {
    const res = await send('get', `/applicants/${ids.applicant}/360`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.applicant.panMasked).toBeTruthy();
    expectClean(res.text);
  });

  it('GET /applicants/:id/duplicates', async () => {
    const phone = digits(2);
    const a = await systemPrisma.applicant.findUnique({ where: { id: ids.applicant } });
    // Two applicants sharing a phone, both carrying a stored ciphertext.
    const d1 = await systemPrisma.applicant.create({ data: { companyId: fx.companyId, name: `IDF D1 ${TAG}`, primaryPhone: phone, primaryPhoneNormalized: phone, panCiphertext: a.panCiphertext, panMasked: a.panMasked } });
    await systemPrisma.applicant.create({ data: { companyId: fx.companyId, name: `IDF D2 ${TAG}`, primaryPhone: phone, primaryPhoneNormalized: phone, panCiphertext: a.panCiphertext, panMasked: a.panMasked } });
    const res = await send('get', `/applicants/${d1.id}/duplicates`);
    expect(res.status, res.text).toBe(200);
    expect(res.body.length).toBe(1);
    expectClean(res.text);
  });

  it('POST /brokers and PATCH /brokers/:id return only the masked value', async () => {
    const created = await send('post', '/brokers', { name: `IDF Broker ${TAG}`, phone: digits(3), pan: PAN });
    expect(created.status, created.text).toBe(201);
    ids.broker = created.body.id;
    await rememberCiphertexts();
    expectClean(created.text);
    const updated = await send('patch', `/brokers/${ids.broker}`, { pan: PAN2 });
    expect(updated.status, updated.text).toBe(200);
    await rememberCiphertexts();
    expectClean(updated.text);
  });

  it('every applicant and broker read is clean too', async () => {
    for (const path of [`/applicants/${ids.applicant}`, '/applicants?limit=100', `/brokers/${ids.broker}`, '/brokers?limit=100', '/inquiries?limit=100']) {
      const res = await send('get', path);
      expect(res.status, `${path}: ${res.text.slice(0, 200)}`).toBe(200);
      expectClean(res.text);
    }
  });

  it('a new audit row stores no restricted field in its snapshot', async () => {
    const rows = await systemPrisma.auditLog.findMany({ where: { companyId: fx.companyId, entityType: { in: ['Applicant', 'Broker'] } } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expectClean(JSON.stringify({ before: r.before, after: r.after }));
  });

  it('an audit row stored earlier has the fields dropped in the GET /audit response', async () => {
    // As an older release could have written it; stored rows are never changed.
    const old = await systemPrisma.auditLog.create({
      data: {
        companyId: fx.companyId, userId: ids.admin, entityType: 'Applicant', entityId: ids.applicant, action: 'UPDATE',
        before: { panCiphertext: ciphertexts[0], panKeyVersion: 1, city: 'Pune' }, after: { panCiphertext: '[REDACTED]', panKeyVersion: 1, panMasked: 'ABXXXXX34F' },
      },
    });
    const res = await send('get', `/audit?entityId=${ids.applicant}&limit=100`);
    expect(res.status, res.text).toBe(200);
    const row = res.body.data.find((r: { id: string }) => r.id === old.id);
    expect(row.before).toEqual({ city: 'Pune' });
    expect(row.after).toEqual({ panMasked: 'ABXXXXX34F' });
    expectClean(res.text);
    const stored = await systemPrisma.auditLog.findUnique({ where: { id: old.id } });
    expect(stored.before.panCiphertext).toBe(ciphertexts[0]);
  });
});
