/**
 * Part H (UA-116): a session ends on its very next request once it is no longer
 * authorised, instead of the access token living out its 15 minutes.
 *
 * Every refusal test signs the user in, proves the token works, performs the
 * event through the real admin or self-service route, then shows that the SAME
 * access token is refused with 401 "Your session has ended. Please sign in
 * again." Controls prove that unrelated users, other roles and the user's own
 * new sign-in keep working. Each refusal is mutation-checked against the code
 * without SessionVersionGuard (the tokens kept working there).
 *
 * Events (staff and portal mirrored): deactivation, role change, an edit to the
 * role's permissions, a self-service password change (the OTHER sessions), an
 * admin password reset, an admin 2FA reset, and a portal re-invite of an existing
 * account (it replaces the password).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import * as argon2 from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, SESSION_ENDED_MESSAGE } from '@openestate/shared';
import { makeClients, seedCompany, makePortalRole, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379';
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const TAG = Date.now();
const PASSWORD = 'SessionVersionPass123';
const NEW_PASSWORD = 'SessionVersionNew456';

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-authz-version-${process.pid}-${TAG}-`;
// This file signs portal users in more often than the production 5 per 5
// minutes per IP allows; scoped to this file's fork (see e2e-admin-2fa-reset).
process.env.PORTAL_AUTH_THROTTLE_LIMIT = '200';
process.env.JWT_ACCESS_SECRET ??= 'e2e-test-access-secret-0123456789';

function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  for (const h of headers) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(h);
    if (match) return match[1];
  }
  return undefined;
}

describeIf('session authorisation version (UA-116), staff and portal', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let passwordHash: string;
  let adminEmail: string;
  let execPerms: string[];
  let customerRoleId: string;
  let seq = 0;
  let makeRole: (name: string, keys: readonly string[]) => Promise<string>;
  let permIdsFor: (keys: readonly string[]) => string[];

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;
    process.env.DATABASE_URL_SYSTEM = SYSTEM_URL;
    process.env.REDIS_URL = REDIS_URL;
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
    passwordHash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const permissions = await systemPrisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map<string, string>(permissions.map((p: { id: string; key: string }) => [p.key, p.id]));
    permIdsFor = (keys) => keys.map((k) => permByKey.get(k)).filter((id): id is string => !!id);
    const grant = async (roleId: string, keys: readonly string[]) => {
      await systemPrisma.rolePermission.createMany({ data: permIdsFor(keys).map((permissionId) => ({ roleId, permissionId })) });
    };
    makeRole = async (name: string, keys: readonly string[]) => {
      const role = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name, slug: `e2e-av-${name.toLowerCase().replace(/\W+/g, '-')}-${TAG}-${++seq}`, isSystem: false },
      });
      await grant(role.id, keys);
      return role.id as string;
    };
    execPerms = [...ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]];
    const adminRoleId = await makeRole('Admin', ALL_PERMISSIONS);
    adminEmail = (await createStaff(adminRoleId)).email;
    customerRoleId = await makePortalRole(systemPrisma, fx.companyId, 'customer');
    await grant(customerRoleId, ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  // ── fixtures and helpers ──

  async function createStaff(roleId: string) {
    const email = `e2e-av-${TAG}-${++seq}@test.com`;
    const user = await systemPrisma.user.create({
      data: { companyId: fx.companyId, email, passwordHash, name: `Staff ${seq}`, roleId, forcePasswordChange: false },
    });
    return { id: user.id as string, email };
  }

  async function createCustomer() {
    const n = ++seq;
    const phone = `7${String(TAG).slice(-6)}${String(n).padStart(3, '0')}`;
    const applicant = await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: `Customer ${n}`, primaryPhone: phone, primaryPhoneNormalized: phone },
    });
    const user = await systemPrisma.user.create({
      data: { companyId: fx.companyId, applicantId: applicant.id, phone, name: `Customer ${n}`, passwordHash, roleId: customerRoleId, forcePasswordChange: false },
    });
    return { id: user.id as string, phone, applicantId: applicant.id as string };
  }

  async function staffSession(email: string, password = PASSWORD) {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email, password }).expect(200);
    return { agent, token: login.body.accessToken as string, csrf: cookieValue(login.headers['set-cookie'], 'openestate_csrf')! };
  }

  async function portalSession(phone: string, password = PASSWORD) {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/portal/auth/login').send({ identifier: phone, password }).expect(200);
    return { agent, token: login.body.accessToken as string, csrf: cookieValue(login.headers['set-cookie'], 'openestate_portal_csrf')! };
  }

  const staffProbe = (token: string) => request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const portalProbe = (token: string) => request(app.getHttpServer()).get('/api/v1/portal/auth/me').set('Authorization', `Bearer ${token}`);

  async function expectEnded(res: request.Response) {
    expect(res.status).toBe(401);
    expect(res.body.message).toBe(SESSION_ENDED_MESSAGE);
  }

  /** Admin action through the real route, with the admin's own fresh session. */
  async function admin(method: 'post' | 'patch', path: string, body?: object) {
    const s = await staffSession(adminEmail);
    return s.agent[method](`/api/v1${path}`).set('Authorization', `Bearer ${s.token}`).set('X-CSRF-Token', s.csrf).send(body ?? {});
  }

  // ── staff ──

  it('staff, deactivated: the very next request with the old token is refused; an unrelated user carries on', async () => {
    const roleId = await makeRole('Exec deact', execPerms);
    const target = await createStaff(roleId);
    const bystander = await createStaff(roleId);
    const t = await staffSession(target.email);
    const b = await staffSession(bystander.email);
    expect((await staffProbe(t.token)).status).toBe(200);
    expect((await admin('post', `/users/${target.id}/deactivate`)).status).toBe(200);
    await expectEnded(await staffProbe(t.token));
    expect((await staffProbe(b.token)).status).toBe(200);
  });

  it('staff, role changed: the old token is refused, and the user\'s own new sign-in works', async () => {
    const roleA = await makeRole('Exec rc A', execPerms);
    const roleB = await makeRole('Exec rc B', execPerms);
    const target = await createStaff(roleA);
    const t = await staffSession(target.email);
    expect((await staffProbe(t.token)).status).toBe(200);
    expect((await admin('patch', `/users/${target.id}`, { roleId: roleB })).status).toBe(200);
    await expectEnded(await staffProbe(t.token));
    const again = await staffSession(target.email);
    expect((await staffProbe(again.token)).status).toBe(200);
  });

  it('staff, role permissions edited: every holder of that role is refused; a user of another role is not', async () => {
    const roleA = await makeRole('Exec pe A', execPerms);
    const roleB = await makeRole('Exec pe B', execPerms);
    const a1 = await staffSession((await createStaff(roleA)).email);
    const a2 = await staffSession((await createStaff(roleA)).email);
    const b1 = await staffSession((await createStaff(roleB)).email);
    const narrower = permIdsFor(execPerms.slice(1));
    expect((await admin('patch', `/roles/${roleA}`, { permissionIds: narrower })).status).toBe(200);
    await expectEnded(await staffProbe(a1.token));
    await expectEnded(await staffProbe(a2.token));
    expect((await staffProbe(b1.token)).status).toBe(200);
  });

  it('staff, own password changed: the OTHER session is refused and cannot refresh; this session refreshes and continues', async () => {
    const target = await createStaff(await makeRole('Exec pw', execPerms));
    const here = await staffSession(target.email);
    const elsewhere = await staffSession(target.email);
    await here.agent
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${here.token}`)
      .set('X-CSRF-Token', here.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);
    await expectEnded(await staffProbe(elsewhere.token));
    // The other session's refresh token was revoked too, so it cannot renew.
    expect((await elsewhere.agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', elsewhere.csrf)).status).toBe(401);
    // This browser's old access token is refused as well, but its refresh token
    // survived, so it gets a fresh token silently and carries on.
    await expectEnded(await staffProbe(here.token));
    const refreshed = await here.agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', here.csrf).expect(200);
    expect((await staffProbe(refreshed.body.accessToken)).status).toBe(200);
    // And the new password signs in.
    expect((await staffProbe((await staffSession(target.email, NEW_PASSWORD)).token)).status).toBe(200);
  });

  it('staff, admin password reset used: the old token is refused', async () => {
    const target = await createStaff(await makeRole('Exec ar', execPerms));
    const t = await staffSession(target.email);
    const link = await admin('post', `/users/${target.id}/force-password-reset`);
    expect(link.status).toBe(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: link.body.token, newPassword: NEW_PASSWORD })
      .expect(204);
    await expectEnded(await staffProbe(t.token));
  });

  it('staff, 2FA reset by an admin: the old token is refused', async () => {
    const target = await createStaff(await makeRole('Exec 2fa', execPerms));
    const t = await staffSession(target.email);
    expect((await admin('post', `/users/${target.id}/reset-2fa`)).status).toBe(200);
    await expectEnded(await staffProbe(t.token));
  });

  it('a token without an authorisation version (issued before this check existed) is refused', async () => {
    const target = await createStaff(await makeRole('Exec noav', execPerms));
    const t = await staffSession(target.email);
    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    const payload = jwt.decode(t.token) as Record<string, unknown>;
    expect(typeof payload.av).toBe('number');
    delete payload.av;
    await expectEnded(await staffProbe(jwt.sign(payload)));
  });

  // ── portal (mirrored) ──

  it('portal, deactivated: the very next request with the old token is refused; another customer carries on', async () => {
    const target = await createCustomer();
    const other = await createCustomer();
    const t = await portalSession(target.phone);
    const o = await portalSession(other.phone);
    expect((await portalProbe(t.token)).status).toBe(200);
    expect((await admin('post', `/users/${target.id}/deactivate`)).status).toBe(200);
    await expectEnded(await portalProbe(t.token));
    expect((await portalProbe(o.token)).status).toBe(200);
  });

  it('portal, own password changed: the OTHER session is refused; the new password signs in', async () => {
    const target = await createCustomer();
    const here = await portalSession(target.phone);
    const elsewhere = await portalSession(target.phone);
    await here.agent
      .post('/api/v1/portal/auth/change-password')
      .set('Authorization', `Bearer ${here.token}`)
      .set('X-CSRF-Token', here.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);
    await expectEnded(await portalProbe(elsewhere.token));
    expect((await elsewhere.agent.post('/api/v1/portal/auth/refresh').set('X-CSRF-Token', elsewhere.csrf)).status).toBe(401);
    expect((await portalProbe((await portalSession(target.phone, NEW_PASSWORD)).token)).status).toBe(200);
  });

  it('portal, admin password reset used: the old token is refused', async () => {
    const target = await createCustomer();
    const t = await portalSession(target.phone);
    const link = await admin('post', '/admin/portal-password-resets', { applicantId: target.applicantId });
    expect(link.status).toBe(200);
    await request(app.getHttpServer())
      .post('/api/v1/portal/auth/password-reset/confirm')
      .send({ token: link.body.token, newPassword: NEW_PASSWORD })
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    await expectEnded(await portalProbe(t.token));
  });

  it('portal, 2FA reset by an admin: the old token is refused', async () => {
    const target = await createCustomer();
    const t = await portalSession(target.phone);
    expect((await admin('post', '/admin/portal-2fa-resets', { applicantId: target.applicantId })).status).toBe(200);
    await expectEnded(await portalProbe(t.token));
  });

  it('portal, re-invited (replaces the password): the old session is refused and its refresh token revoked; the invite session works', async () => {
    const target = await createCustomer();
    const t = await portalSession(target.phone);
    const invite = await admin('post', '/admin/portal-invites', { applicantId: target.applicantId, channel: 'SMS' });
    expect(invite.status).toBe(201);
    const consumed = await request(app.getHttpServer())
      .post(`/api/v1/portal/auth/invite/${invite.body.inviteId}/consume`)
      .send({ token: invite.body.token, password: NEW_PASSWORD });
    expect([200, 201]).toContain(consumed.status);
    await expectEnded(await portalProbe(t.token));
    expect((await t.agent.post('/api/v1/portal/auth/refresh').set('X-CSRF-Token', t.csrf)).status).toBe(401);
    expect((await portalProbe(consumed.body.accessToken)).status).toBe(200);
  });

  // ── self-service 2FA enable and disable: other sessions end, this one refreshes ──

  const totpCode = (secret: string) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();

  /**
   * Enables 2FA from session `here` through the real routes, checks the other
   * session ended, then refreshes `here` (as the browser does) and disables 2FA
   * from it, checking a second other session ended too.
   */
  async function enableThenDisable(
    surface: 'staff' | 'portal',
    sessionFor: () => Promise<{ agent: ReturnType<typeof request.agent>; token: string; csrf: string }>,
  ) {
    const base = surface === 'staff' ? '/api/v1/auth' : '/api/v1/portal/auth';
    const probe = surface === 'staff' ? staffProbe : portalProbe;
    const here = await sessionFor();
    const elsewhere = await sessionFor();
    const setup = await here.agent
      .post(`${base}/totp/setup`)
      .set('Authorization', `Bearer ${here.token}`)
      .set('X-CSRF-Token', here.csrf)
      .expect((r) => expect([200, 201]).toContain(r.status));
    await here.agent
      .post(`${base}/totp/confirm`)
      .set('Authorization', `Bearer ${here.token}`)
      .set('X-CSRF-Token', here.csrf)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    // The other session is refused and cannot renew.
    await expectEnded(await probe(elsewhere.token));
    expect((await elsewhere.agent.post(`${base}/refresh`).set('X-CSRF-Token', elsewhere.csrf)).status).toBe(401);
    // This browser refreshes once and carries on.
    await expectEnded(await probe(here.token));
    const refreshed = await here.agent.post(`${base}/refresh`).set('X-CSRF-Token', here.csrf).expect(200);
    const hereCsrf = cookieValue(refreshed.headers['set-cookie'], surface === 'staff' ? 'openestate_csrf' : 'openestate_portal_csrf') ?? here.csrf;
    expect((await probe(refreshed.body.accessToken)).status).toBe(200);

    // A second session (now needs the code), then disable from this browser.
    const loginPath = surface === 'staff' ? '/api/v1/auth/login' : '/api/v1/portal/auth/login';
    const second = request.agent(app.getHttpServer());
    const pending = await second.post(loginPath).send(await credentialsFor()).expect(200);
    expect(pending.body.requiresTwoFactor).toBe(true);
    const verified = await second
      .post(`${base}/totp/verify`)
      .set('Authorization', `Bearer ${pending.body.tempToken}`)
      .set('X-CSRF-Token', cookieValue(pending.headers['set-cookie'], surface === 'staff' ? 'openestate_csrf' : 'openestate_portal_csrf')!)
      .send({ code: totpCode(setup.body.secret) })
      .expect(200);
    expect((await probe(verified.body.accessToken)).status).toBe(200);
    await here.agent
      .post(`${base}/totp/disable`)
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .set('X-CSRF-Token', hereCsrf)
      .expect(204);
    await expectEnded(await probe(verified.body.accessToken));
    const again = await here.agent.post(`${base}/refresh`).set('X-CSRF-Token', hereCsrf).expect(200);
    expect((await probe(again.body.accessToken)).status).toBe(200);
  }

  let credentialsFor: () => Promise<object> = async () => ({});

  it('staff, own 2FA enabled then disabled: each time the other session ends and this one refreshes', async () => {
    const target = await createStaff(await makeRole('Exec self2fa', execPerms));
    credentialsFor = async () => ({ email: target.email, password: PASSWORD });
    await enableThenDisable('staff', () => staffSession(target.email));
  });

  it('portal, own 2FA enabled then disabled: each time the other session ends and this one refreshes', async () => {
    const target = await createCustomer();
    credentialsFor = async () => ({ identifier: target.phone, password: PASSWORD });
    await enableThenDisable('portal', () => portalSession(target.phone));
  });

  it('cache is write-through: right after a bump, Redis already holds the new version', async () => {
    const target = await createStaff(await makeRole('Exec cache', execPerms));
    const t = await staffSession(target.email);
    expect((await staffProbe(t.token)).status).toBe(200); // fills the cache
    expect((await admin('post', `/users/${target.id}/deactivate`)).status).toBe(200);
    const redis = new Redis(REDIS_URL);
    try {
      const cached = await redis.get(`authz:v:${target.id}`);
      const row = await systemPrisma.user.findUniqueOrThrow({ where: { id: target.id }, select: { authzVersion: true } });
      expect(cached).not.toBeNull();
      expect(row.authzVersion).toBeGreaterThan(0); // the deactivation bumped it
      expect(Number(cached)).toBe(row.authzVersion);
      expect(await redis.ttl(`authz:v:${target.id}`)).toBeLessThanOrEqual(60);
    } finally {
      redis.disconnect();
    }
  });

  // ── a version bumped directly in the database (the upgrade sync) ──
  //
  // packages/db/prisma/sync-permissions.ts bumps users.authz_version with plain
  // SQL when an upgrade grants permissions, and does not touch the Redis cache.
  // Found by PR #78's CI: a session that refreshed within 60 s of such a bump
  // got a token with the new version, which the guard compared with the old
  // cached one and refused, signing the user out.

  const jwtDecode = (token: string) => new JwtService({}).decode(token);
  const bumpInDatabase = (userId: string) =>
    systemPrisma.$executeRaw`UPDATE users SET authz_version = authz_version + 1 WHERE id = ${userId}::uuid`;
  const cachedVersion = async (userId: string) => {
    const redis = new Redis(REDIS_URL);
    try {
      const v = await redis.get(`authz:v:${userId}`);
      return v === null ? null : Number(v);
    } finally {
      redis.disconnect();
    }
  };
  const dbVersion = async (userId: string) =>
    (await systemPrisma.user.findUniqueOrThrow({ where: { id: userId }, select: { authzVersion: true } })).authzVersion as number;

  it('direct database bump, cache still old: a refreshed session carries on, and the cache catches up', async () => {
    const target = await createStaff(await makeRole('Exec direct bump', execPerms));
    const t = await staffSession(target.email);
    expect((await staffProbe(t.token)).status).toBe(200); // fills the cache
    const before = await dbVersion(target.id);
    await bumpInDatabase(target.id);
    expect(await cachedVersion(target.id)).toBe(before); // premise: the cache is stale

    const refreshed = await t.agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', t.csrf).expect(200);
    expect((jwtDecode(refreshed.body.accessToken) as { av: number }).av).toBe(before + 1);
    expect((await staffProbe(refreshed.body.accessToken)).status).toBe(200);
    expect(await cachedVersion(target.id)).toBe(before + 1);
  });

  it('control: a token newer than the database is refused, even with a stale cache', async () => {
    const target = await createStaff(await makeRole('Exec forged av', execPerms));
    const t = await staffSession(target.email);
    expect((await staffProbe(t.token)).status).toBe(200);
    const payload = jwtDecode(t.token) as Record<string, unknown> & { av: number };
    const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
    delete payload.exp;
    await expectEnded(await staffProbe(jwt.sign({ ...payload, av: payload.av + 5 }, { expiresIn: '15m' })));
  });

  it('control: after an in-app session end (password change) the old access token is refused', async () => {
    const target = await createStaff(await makeRole('Exec in-app end', execPerms));
    const here = await staffSession(target.email);
    expect((await staffProbe(here.token)).status).toBe(200);
    await here.agent
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${here.token}`)
      .set('X-CSRF-Token', here.csrf)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);
    await expectEnded(await staffProbe(here.token));
  });

  it('known window (docs/todo.md): an OLD token is accepted while the cache still holds the old version after a direct bump', async () => {
    const target = await createStaff(await makeRole('Exec old token', execPerms));
    const t = await staffSession(target.email);
    expect((await staffProbe(t.token)).status).toBe(200);
    const before = await dbVersion(target.id);
    await bumpInDatabase(target.id);
    expect(await cachedVersion(target.id)).toBe(before);
    // Not fixed here (owner ruling): only an in-app bump updates the cache, so
    // until the 60 s entry expires the old token still matches it. Harmless
    // while the upgrade sync only adds permissions.
    expect((await staffProbe(t.token)).status).toBe(200);
  });

  // Last: it ends the session of every customer in this company.
  it('portal, the customer role\'s permissions edited: the customer is refused; a staff session is not', async () => {
    const target = await createCustomer();
    const t = await portalSession(target.phone);
    const staff = await staffSession((await createStaff(await makeRole('Exec bystander', execPerms))).email);
    const same = permIdsFor(ROLE_PERMISSIONS[SYSTEM_ROLES.CUSTOMER]);
    expect((await admin('patch', `/roles/${customerRoleId}`, { permissionIds: same })).status).toBe(200);
    await expectEnded(await portalProbe(t.token));
    expect((await staffProbe(staff.token)).status).toBe(200);
    expect((await portalProbe((await portalSession(target.phone)).token)).status).toBe(200);
  });
});
