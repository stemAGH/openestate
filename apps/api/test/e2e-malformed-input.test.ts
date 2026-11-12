/**
 * Malformed input never reaches the database as a 500.
 *
 *  - A path or query id that isn't a UUID is refused with 400 on every
 *    staff route (walks the app's own route table, so a new route is
 *    covered without editing this file).
 *  - A search term containing a NUL character is refused with 400 on the
 *    list endpoints (Postgres can't store or compare `\0` in text).
 *  - Applicant search finds a phone however it is typed, as the inquiry
 *    search already does ("98111 00001", "+91 98111 00001", …).
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
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PASSWORD = 'StaffPass123';
const TAG = `${Date.now()}-${process.pid}`;
const EMAIL = `e2e-malformed-${TAG}@test.com`;
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-malformed-input-${TAG}-`;

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

/** Every route Express knows about: [METHOD, '/api/v1/...'] with :params. */
function routeTable(app: INestApplication): Array<[string, string]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express internals, read-only
  const stack: any[] = app.getHttpAdapter().getInstance()._router.stack;
  const out: Array<[string, string]> = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) out.push([method.toUpperCase(), layer.route.path]);
  }
  return out;
}

describeIf('e2e malformed input: 400, never 500', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let token = '';

  const send = (method: string, url: string) => {
    const r = request(app.getHttpServer())[method.toLowerCase() as 'get'](url).set('Authorization', `Bearer ${token}`);
    return method === 'GET' || method === 'DELETE' ? r : r.send({});
  };

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const perms = await systemPrisma.permission.findMany();
    const role = await systemPrisma.role.create({ data: { companyId: fx.companyId, name: `All ${TAG}`, slug: `all-${TAG}` } });
    await systemPrisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
    const hash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });
    await systemPrisma.user.create({
      data: { companyId: fx.companyId, email: EMAIL, name: 'Malformed Input', passwordHash: hash, roleId: role.id, forcePasswordChange: false },
    });
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200);
    token = res.body.accessToken;
    for (const phone of ['9811100001', '9811100002']) {
      await systemPrisma.applicant.create({
        data: { companyId: fx.companyId, name: `Search ${phone}`, primaryPhone: phone, primaryPhoneNormalized: phone },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await app.close();
  });

  it('refuses a malformed path id with 400 on representative routes, and a well-formed unknown id still gets 404', async () => {
    for (const url of [
      '/api/v1/users/abc', '/api/v1/roles/abc', '/api/v1/masters/unit-types/abc', '/api/v1/projects/abc',
      '/api/v1/applicants/abc/360', '/api/v1/inquiries/abc', '/api/v1/bookings/abc', '/api/v1/brokers/0',
      `/api/v1/projects/${fx.projectId}/units/abc`,
    ]) {
      const res = await send('GET', url);
      expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(String(res.body.message)).toMatch(/must be a valid id/);
    }
    const unknown = await send('GET', '/api/v1/projects/00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
  });

  it('refuses a malformed id in a query parameter with 400', async () => {
    const res = await send('GET', '/api/v1/admin/construction-updates?projectId=abc');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // An empty value still means "no filter".
    const empty = await send('GET', `/api/v1/projects/${fx.projectId}/units?towerId=`);
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
  });

  it('leaves non-id parameters alone (a plugin is named, not numbered)', async () => {
    const res = await send('GET', '/api/v1/admin/plugins/no-such-plugin');
    expect(res.status).not.toBe(400);
    expect(res.status).toBeLessThan(500);
  });

  it('never answers 500 to a malformed id on any staff route', async () => {
    const routes = routeTable(app).filter(([, p]) => p.includes(':') && !p.includes('/portal/') && !p.includes('/auth/'));
    expect(routes.length, 'routes with parameters found in the route table').toBeGreaterThan(150);
    const failures: string[] = [];
    for (const [method, path] of routes) {
      for (const bad of ['abc', '0', "'%22"]) {
        const url = path.replace(/:([A-Za-z]+)/g, (_m, name) => (name === 'pluginId' ? 'no-such-plugin' : bad));
        const res = await send(method, url);
        if (res.status >= 500) failures.push(`${method} ${path} [${bad}] -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('refuses a NUL character in a search term with 400 on list endpoints', async () => {
    for (const path of ['/api/v1/users', '/api/v1/masters/unit-types', '/api/v1/projects', '/api/v1/applicants', '/api/v1/inquiries', '/api/v1/brokers', '/api/v1/masters/lead-stages', '/api/v1/masters/gst-rates']) {
      const ok = await send('GET', `${path}?search=abc`);
      expect(ok.status, `${path} control`).toBe(200);
      const res = await send('GET', `${path}?search=a%00b`);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(400);
    }
  });

  it('finds an applicant by phone however it is typed', async () => {
    for (const q of ['9811100001', '98111 00001', '+91 98111 00001', '+919811100001', '09811100001', '98111-00001']) {
      const res = await send('GET', `/api/v1/applicants?search=${encodeURIComponent(q)}&limit=10`);
      expect(res.status).toBe(200);
      const names = res.body.data.map((a: { name: string }) => a.name);
      expect(names, `search "${q}"`).toEqual(['Search 9811100001']);
    }
  });
});
