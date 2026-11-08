/**
 * Through-the-wire coverage for the two endpoints added alongside the
 * dashboard and hierarchy screens:
 *
 *   GET /dashboard        — own work summary + reporting-subtree summary
 *   GET /users/hierarchy  — read-only org tree, scoped the same way
 *
 * Real HTTP, per the standing rule that a direct-service-call test proves
 * handler logic but never that the route is registered or that the
 * permission guard actually gates it. Two things here can ONLY be caught
 * over the wire:
 *
 *   - `/users/hierarchy` is declared above `@Get(':id')`. With the order
 *     reversed, Express matches `:id` first and the request 404s as
 *     `id="hierarchy"` — the exact hazard that bit `/inquiries/import-template`
 *     (CLAUDE.md v0.3.1). A direct `usersService.getHierarchy()` call
 *     cannot see route registration at all.
 *   - `sales_executive` genuinely lacks `ADMIN_USER_READ`, so the 403 on
 *     hierarchy is a real permission boundary being asserted, not a
 *     synthetic one.
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
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES, istDayBounds } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  cleanupCompany,
  makeApplicant,
  type CompanyFixture,
} from './helpers/postsales-harness';

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
// so RedisThrottlerStorage picks it up. Six other e2e files already do
// this and omitting it here broke CI: the default bucket is IP-keyed
// (100/min) and every e2e file shares one loopback IP and one Redis, so
// this file's logins pushed an already-near-limit shared bucket over and
// four UNRELATED files started failing with 429 on login. Isolating the
// keyspace removes this file's contribution to that shared budget
// entirely. See RedisThrottlerStorage + CLAUDE.md's Phase 8 entry.
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-dashboard-hierarchy-${process.pid}-${Date.now()}-`;

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

describeIf('e2e GET /dashboard and GET /users/hierarchy', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;

  let managerEmail: string;
  let repEmail: string;
  let peerEmail: string;
  let adminEmail: string;
  let customAdminEmail: string;
  let managerId: string;
  let repId: string;
  let peerId: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p: { key: string; id: string }) => [p.key, p.id]));

    const roleWith = async (name: string, slug: string, keys: readonly string[]) => {
      const role = await systemPrisma.role.create({
        data: { companyId: fx.companyId, name, slug, isSystem: false },
      });
      await systemPrisma.rolePermission.createMany({
        data: keys
          .map((k) => permByKey.get(k))
          .filter((id): id is string => !!id)
          .map((permissionId) => ({ roleId: role.id, permissionId })),
      });
      return role;
    };

    // Real permission sets, not hand-picked ones — the point of the 403
    // assertion below is that sales_executive's REAL grants exclude
    // ADMIN_USER_READ, which a bespoke list would quietly paper over.
    const managerRole = await roleWith(
      `E2E DashMgr ${TAG}`,
      `e2e-dash-mgr-${TAG}`,
      ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER],
    );
    const repRole = await roleWith(
      `E2E DashRep ${TAG}`,
      `e2e-dash-rep-${TAG}`,
      ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE],
    );
    // Slug must be literally `company_admin` — TeamScopeService keys
    // admin-tier ("see the whole company") off the role SLUG, not off the
    // permission set. A tagged slug like `e2e-dash-admin-123` is treated
    // as an ordinary role and scoped to its own subtree no matter how many
    // permissions it holds. Each test file gets its own fresh company from
    // seedCompany, so claiming the real slug here collides with nothing.
    const adminRole = await roleWith(
      'Company Admin',
      SYSTEM_ROLES.COMPANY_ADMIN,
      ROLE_PERMISSIONS[SYSTEM_ROLES.COMPANY_ADMIN],
    );

    // A company's own role, holding literally every permission but with a
    // slug that is none of the seeded ones — the case the old slug check
    // silently got wrong.
    const customAdminRole = await roleWith(
      `E2E Custom Administrator ${TAG}`,
      `e2e-custom-administrator-${TAG}`,
      ALL_PERMISSIONS,
    );

    const mkUser = async (email: string, name: string, roleId: string, roleSlug: string) => {
      const u = await systemPrisma.user.create({
        data: {
          companyId: fx.companyId,
          email,
          passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
          name,
          roleId,
          forcePasswordChange: false,
        },
      });
      return u;
    };

    managerEmail = `e2e-dash-mgr-${TAG}@test.com`;
    repEmail = `e2e-dash-rep-${TAG}@test.com`;
    peerEmail = `e2e-dash-peer-${TAG}@test.com`;
    adminEmail = `e2e-dash-admin-${TAG}@test.com`;
    customAdminEmail = `e2e-dash-custom-admin-${TAG}@test.com`;

    const manager = await mkUser(managerEmail, 'E2E Dash Manager', managerRole.id, 'mgr');
    const rep = await mkUser(repEmail, 'E2E Dash Rep', repRole.id, 'rep');
    const peer = await mkUser(peerEmail, 'E2E Dash Peer', repRole.id, 'rep');
    await mkUser(adminEmail, 'E2E Dash Admin', adminRole.id, 'admin');
    // No manager, no reports — so subtree-scoping would give them nothing.
    await mkUser(customAdminEmail, 'E2E Dash Custom Admin', customAdminRole.id, 'custom');
    managerId = manager.id;
    repId = rep.id;
    peerId = peer.id;

    // Org chart: rep reports to manager. Peer reports to NOBODY, so the
    // manager must never see them in either endpoint.
    await systemPrisma.user.update({ where: { id: repId }, data: { managerId } });

    // Inquiries: one due today and one overdue for the rep, one
    // SUCCESSFUL for the rep (this month), one for the peer that must
    // never appear in the manager's numbers.
    const now = new Date();
    // Noon on the IST calendar day ("due today" is an IST day now).
    const today = new Date(istDayBounds(now).startOfToday.getTime() + 12 * 3_600_000);
    const overdue = new Date(now.getTime() - 3 * 86_400_000);

    const mkInquiry = async (
      assignedToId: string,
      status: string,
      nextFollowupAt: Date | null,
    ) => {
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      return systemPrisma.inquiry.create({
        data: {
          companyId: fx.companyId,
          applicantId,
          assignedToId,
          status,
          nextFollowupAt,
          // Seeded straight through Prisma, which deliberately bypasses
          // InquiryService.update() and therefore never stamps
          // convertedAt — so a SUCCESSFUL fixture row has to carry its own
          // conversion date, exactly as the migration's backfill gives one
          // to pre-existing rows.
          ...(status === 'SUCCESSFUL' ? { convertedAt: new Date() } : {}),
        },
      });
    };

    await mkInquiry(repId, 'OPEN', today);
    await mkInquiry(repId, 'OPEN', overdue);
    await mkInquiry(repId, 'SUCCESSFUL', null);
    await mkInquiry(peerId, 'OPEN', today);
    await mkInquiry(peerId, 'OPEN', overdue);
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  // Memoized: the tests across these distinct users needed one login each
  // every time, which is repeated hits on a rate-limited endpoint for no
  // added coverage — none of them assert anything about login itself.
  const tokenCache = new Map<string, string>();
  const csrfCache = new Map<string, { csrf: string; cookie: string }>();

  function captureCsrf(email: string, setCookie: string[] | string | undefined) {
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    const csrf = /openestate_csrf=([^;]+)/.exec(headers.join(';'))?.[1] ?? '';
    const cookie = headers.map((c) => c.split(';')[0]).join('; ');
    csrfCache.set(email, { csrf, cookie });
  }

  async function tokenFor(email: string): Promise<string> {
    const cached = tokenCache.get(email);
    if (cached) return cached;
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: STAFF_PASSWORD })
      .expect(200);
    const token = res.body.accessToken as string;
    tokenCache.set(email, token);
    captureCsrf(email, res.headers['set-cookie']);
    return token;
  }

  /** CSRF pair from the same login the token came from — mutations need both. */
  async function csrfFor(email: string): Promise<{ csrf: string; cookie: string }> {
    await tokenFor(email);
    return csrfCache.get(email)!;
  }

  describe('GET /dashboard', () => {
    it('a rep with no reports gets their own figures and a null team', async () => {
      const token = await tokenFor(repEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.team).toBeNull();
      expect(res.body.mine.followUpsToday).toBe(1);
      expect(res.body.mine.followUpsOverdue).toBe(1);
      expect(res.body.mine.openInquiries).toBe(2);
      expect(res.body.mine.conversionsThisMonth).toBe(1);
    });

    it("a manager's team block covers their subtree and excludes an unrelated peer", async () => {
      const token = await tokenFor(managerEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The manager owns no inquiries themselves.
      expect(res.body.mine.openInquiries).toBe(0);

      // ...but their team's figures are exactly the rep's, NOT the peer's
      // (which would double every count if scoping leaked).
      expect(res.body.team).not.toBeNull();
      expect(res.body.team.followUpsToday).toBe(1);
      expect(res.body.team.followUpsOverdue).toBe(1);
      expect(res.body.team.openInquiries).toBe(2);
      expect(res.body.team.memberCount).toBe(2); // manager + rep

      const names = (res.body.team.perReport as Array<{ name: string }>).map((r) => r.name);
      expect(names).toContain('E2E Dash Rep');
      expect(names).not.toContain('E2E Dash Peer');
      // The caller is never in their own per-report table.
      expect(names).not.toContain('E2E Dash Manager');
    });

    it('the per-report row carries the figures the manager needs to spot an inactive report', async () => {
      const token = await tokenFor(managerEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const row = (res.body.team.perReport as Array<Record<string, unknown>>).find(
        (r) => r.name === 'E2E Dash Rep',
      )!;
      expect(row.openInquiries).toBe(2);
      expect(row.followUpsToday).toBe(1);
      expect(row.followUpsOverdue).toBe(1);
      expect(row.conversionsThisMonth).toBe(1);
      // No follow-up rows were created for this fixture, so "never active"
      // must come back as null rather than a fabricated timestamp.
      expect(row.lastActivityAt).toBeNull();
    });

    it("a company's OWN full-permission role gets company-wide scope, not just its subtree", async () => {
      // The regression this guards: admin-tier used to be decided by the
      // role SLUG being literally company_admin/super_admin. A company
      // that built its own "Administrator" role holding every permission
      // was therefore scoped to its own subtree — here, nothing at all,
      // since this user has no reports — and its dashboard silently showed
      // a fraction of the company with no error to explain why. The slug
      // below is deliberately NOT one of the seeded ones.
      const token = await tokenFor(customAdminEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.team).not.toBeNull();
      expect(res.body.team.openInquiries).toBe(4); // whole company, not 0
      const names = (res.body.team.perReport as Array<{ name: string }>).map((r) => r.name);
      expect(names).toContain('E2E Dash Rep');
      expect(names).toContain('E2E Dash Peer');
    });

    it('an admin-tier caller gets the whole company as their team', async () => {
      const token = await tokenFor(adminEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.team).not.toBeNull();
      // Both the rep's and the peer's inquiries, unlike the manager above.
      expect(res.body.team.openInquiries).toBe(4);
      const names = (res.body.team.perReport as Array<{ name: string }>).map((r) => r.name);
      expect(names).toContain('E2E Dash Rep');
      expect(names).toContain('E2E Dash Peer');
    });
  });

  describe('Inquiry.convertedAt', () => {
    it('is stamped on the transition into SUCCESSFUL and does NOT drift when the closed inquiry is edited later', async () => {
      const token = await tokenFor(adminEmail);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const inquiry = await systemPrisma.inquiry.create({
        data: { companyId: fx.companyId, applicantId, assignedToId: null, status: 'OPEN' },
      });

      // Not converted yet.
      expect(
        (await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } })).convertedAt,
      ).toBeNull();

      const csrf = await csrfFor(adminEmail);
      await request(app.getHttpServer())
        .patch(`/api/v1/inquiries/${inquiry.id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf.csrf)
        .set('Cookie', csrf.cookie)
        .send({ status: 'SUCCESSFUL' })
        .expect(200);

      const converted = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
      expect(converted.convertedAt).not.toBeNull();
      const stampedAt = converted.convertedAt.getTime();

      // An unrelated edit afterwards. Pre-fix the figure keyed off
      // updatedAt, so THIS is the moment a months-old conversion silently
      // jumped into the current month.
      await new Promise((r) => setTimeout(r, 20));
      await request(app.getHttpServer())
        .patch(`/api/v1/inquiries/${inquiry.id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-CSRF-Token', csrf.csrf)
        .set('Cookie', csrf.cookie)
        .send({ nextFollowupAt: new Date().toISOString() })
        .expect(200);

      const after = await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } });
      expect(after.convertedAt.getTime()).toBe(stampedAt);
      // ...and updatedAt genuinely did move, so the assertion above is
      // meaningful rather than passing because nothing changed at all.
      expect(after.updatedAt.getTime()).toBeGreaterThan(converted.updatedAt.getTime());
    });

    it('is cleared when the inquiry moves back out of SUCCESSFUL', async () => {
      const token = await tokenFor(adminEmail);
      const csrf = await csrfFor(adminEmail);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const inquiry = await systemPrisma.inquiry.create({
        data: { companyId: fx.companyId, applicantId, status: 'OPEN' },
      });

      const patch = (status: string) =>
        request(app.getHttpServer())
          .patch(`/api/v1/inquiries/${inquiry.id}`)
          .set('Authorization', `Bearer ${token}`)
          .set('X-CSRF-Token', csrf.csrf)
          .set('Cookie', csrf.cookie)
          .send({ status })
          .expect(200);

      await patch('SUCCESSFUL');
      expect(
        (await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } })).convertedAt,
      ).not.toBeNull();

      // A re-opened lead must stop counting as a conversion.
      await patch('CONTINUED');
      expect(
        (await systemPrisma.inquiry.findUnique({ where: { id: inquiry.id } })).convertedAt,
      ).toBeNull();
    });
  });

  describe('GET /users/hierarchy', () => {
    it('resolves to the hierarchy handler, not GET /users/:id', async () => {
      const token = await tokenFor(adminEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/hierarchy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Pre-fix (wrong declaration order) this 404s as "User not found"
      // with id="hierarchy". An array body is proof the real handler ran.
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("a manager sees their own subtree rooted at themselves, with the peer absent", async () => {
      const token = await tokenFor(managerEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/hierarchy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // The manager's own manager is not visible, so the manager is the
      // root — the tree must not come back empty just because the parent
      // is out of scope.
      expect(res.body).toHaveLength(1);
      const root = res.body[0];
      expect(root.name).toBe('E2E Dash Manager');
      expect(root.directReportCount).toBe(1);
      expect(root.reports).toHaveLength(1);
      expect(root.reports[0].name).toBe('E2E Dash Rep');
      expect(root.reports[0].directReportCount).toBe(0);

      const flat = JSON.stringify(res.body);
      expect(flat).not.toContain('E2E Dash Peer');
    });

    it('an admin sees the whole company, including users outside any reporting line', async () => {
      const token = await tokenFor(adminEmail);
      const res = await request(app.getHttpServer())
        .get('/api/v1/users/hierarchy')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const flat = JSON.stringify(res.body);
      expect(flat).toContain('E2E Dash Manager');
      expect(flat).toContain('E2E Dash Rep');
      expect(flat).toContain('E2E Dash Peer');

      // The rep is nested under the manager, never a second root.
      const roots = (res.body as Array<{ name: string }>).map((r) => r.name);
      expect(roots).toContain('E2E Dash Manager');
      expect(roots).not.toContain('E2E Dash Rep');
    });

    it("a sales_executive is 403'd — the real role genuinely lacks ADMIN_USER_READ", async () => {
      const token = await tokenFor(repEmail);
      await request(app.getHttpServer())
        .get('/api/v1/users/hierarchy')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      // Guards against this test silently passing for the wrong reason if
      // the seeded permission set ever changes.
      expect(ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]).not.toContain(
        PERMISSIONS.ADMIN_USER_READ,
      );
    });
  });
});
