/**
 * List endpoints sort only by the columns they show. Before, `sortBy` went
 * straight into the database's ORDER BY: any column could be named
 * (including ones never shown), and an unknown one answered 500.
 *
 * Also: these list queries are strict (an unknown parameter is a 400), and
 * the requests the web app actually makes still work.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, makeBroker, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PASSWORD = 'StaffPass123';
const TAG = `${Date.now()}-${process.pid}`;
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-list-sort-${TAG}-`;

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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const nestApp = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  nestApp.use(cookieParser());
  nestApp.setGlobalPrefix('api/v1');
  nestApp.useGlobalPipes(new ZodValidationPipe());
  await nestApp.init();
  return nestApp;
}

const MASTERS = ['unit-types', 'plc-types', 'inquiry-sources', 'dump-reasons', 'inquiry-types', 'inquiry-temperatures', 'follow-up-types',
  'communication-types', 'project-types', 'receipt-types', 'registration-types', 'area-locations', 'document-types', 'banks', 'charge-types',
  'interest-rules', 'transfer-fee-rules', 'payment-plan-templates', 'ticket-categories', 'tds-rules', 'sms-templates', 'letter-templates', 'lead-stages'];

describeIf('e2e list endpoints: sort only by shown columns, strict queries', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let token = '';
  const get = (url: string) => request(app.getHttpServer()).get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    await makeBroker(systemPrisma, fx.companyId);
    for (const key of ALL_PERMISSIONS) await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    const perms = await systemPrisma.permission.findMany();
    const role = await systemPrisma.role.create({ data: { companyId: fx.companyId, name: `All ${TAG}`, slug: `all-${TAG}` } });
    await systemPrisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
    const email = `e2e-sort-${TAG}@test.com`;
    const hash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });
    await systemPrisma.user.create({ data: { companyId: fx.companyId, email, name: 'Sort Admin', passwordHash: hash, roleId: role.id, forcePasswordChange: false } });
    token = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.accessToken;
  }, 120_000);

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await app.close();
  });

  it('refuses a sort by a column the list does not show, including secret ones', async () => {
    for (const url of [
      '/users?sortBy=passwordHash', '/users?sortBy=totpSecret', '/users?sortBy=createdAt',
      '/applicants?sortBy=panCiphertext', '/applicants?sortBy=primaryPhone', '/brokers?sortBy=panCiphertext',
      '/projects?sortBy=reraNumber', `/projects/${fx.projectId}/units?sortBy=baseRatePaise`, '/masters/banks?sortBy=createdAt',
      '/masters/gst-rates?sortBy=hsnSac', '/masters/lead-stages?sortBy=zzz',
    ]) {
      const res = await get(url);
      expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it('sorts by the columns each list shows', async () => {
    for (const url of [
      '/users?sortBy=name', '/users?sortBy=email&sortOrder=desc', '/applicants?sortBy=name', '/brokers?sortBy=name',
      '/projects?sortBy=code', `/projects/${fx.projectId}/towers?sortBy=code`, `/projects/${fx.projectId}/inventory-groups?sortBy=name`,
      `/projects/${fx.projectId}/units?sortBy=number`, '/masters/gst-rates?sortBy=effectiveFrom', '/masters/tds-rules?sortBy=section',
      ...MASTERS.flatMap((m) => [`/masters/${m}?sortBy=sortOrder&sortOrder=asc`, ...(m === 'gst-rates' || m === 'tds-rules' ? [] : [`/masters/${m}?sortBy=name`])]),
    ]) {
      const res = await get(url);
      expect(res.status, `${url}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    }
  });

  it('refuses an unknown parameter', async () => {
    for (const url of ['/users?qa=1', '/projects?qa=1', '/applicants?qa=1', '/brokers?qa=1', '/masters/banks?qa=1', `/projects/${fx.projectId}/units?qa=1`]) {
      expect((await get(url)).status, url).toBe(400);
    }
  });

  it('still answers the requests the web app makes', async () => {
    for (const url of [
      '/users?page=1&limit=100', '/users?limit=100', '/projects?limit=100', '/brokers?limit=100', '/applicants?search=98&limit=10',
      '/masters/gst-rates?limit=100', '/masters/lead-stages?limit=100', '/masters/charge-types?page=1&limit=50&sortBy=sortOrder&sortOrder=asc',
      `/projects/${fx.projectId}/towers?page=1&limit=100`, `/projects/${fx.projectId}/inventory-groups?page=1&limit=100`,
      `/projects/${fx.projectId}/units?page=1&limit=100&towerId=${fx.towerId}&status=AVAILABLE`, `/projects/${fx.projectId}/units?status=AVAILABLE&limit=100`,
    ]) {
      const res = await get(url);
      expect(res.status, `${url}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
    }
  });
});
