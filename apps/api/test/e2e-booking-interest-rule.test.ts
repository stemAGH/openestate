/**
 * Through-the-wire coverage for attaching a delay-interest rule to a booking
 * (PUT /bookings/:id/interest-rule) and the guards around it: the permission
 * (postsales.interest.manage), the audit row and its actor, SIMPLE-only, the
 * interest-from date over HTTP, manual accrue accepting manage or waive, the
 * master guard on a rule in use, and ON DELETE RESTRICT on
 * bookings.interest_rule_id. The interest arithmetic is
 * postsales-interest-rule.test.ts (fixed clock).
 *
 * Requires the compiled dist/ — see e2e-unit-pricing.test.ts for why.
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
import { makeClients, seedCompany, makeUnit, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-booking-interest-rule-${process.pid}-${Date.now()}-`;

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

describeIf('e2e PUT /bookings/:id/interest-rule and the interest-rule guards', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  const emails = { manage: '', waive: '', none: '', accounts: '', masters: '' };
  let managerId: string;
  let simpleRuleId: string;
  let compoundRuleId: string;
  let spareRuleId: string;

  async function makeStaff(label: string, keys: string[]): Promise<{ email: string; id: string }> {
    const perms = await systemPrisma.permission.findMany({ where: { key: { in: keys } } });
    expect(perms).toHaveLength(keys.length);
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: `E2E ${label}`, slug: `e2e-ir-${label}-${TAG}`, isSystem: false },
    });
    await systemPrisma.rolePermission.createMany({
      data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
    const email = `e2e-ir-${label}-${TAG}@test.com`;
    const user = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: `E2E ${label}`,
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    return { email, id: user.id };
  }

  /** An active booking with one installment that fell due long ago. */
  async function overdueBooking(): Promise<string> {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId,
        primaryApplicantId: applicantId,
        bookingNumber: `E2E-IR-${TAG}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'BOOKED',
        agreedPricePaise: 10_00_000n * 100n,
        bookingDate: new Date('2026-01-01'),
        placeOfSupplyStateCode: '09',
      },
    });
    const plan = await systemPrisma.paymentPlan.create({
      data: { companyId: fx.companyId, bookingId: booking.id, name: 'P', isCustom: true, version: 1 },
    });
    await systemPrisma.installment.create({
      data: {
        companyId: fx.companyId,
        bookingId: booking.id,
        planId: plan.id,
        seq: 1,
        label: 'I1',
        dueDate: new Date('2026-01-01'),
        amountPaise: 10_00_000n * 100n,
      },
    });
    return booking.id;
  }

  async function login(email: string) {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    const auth = { Authorization: `Bearer ${res.body.accessToken}`, 'X-CSRF-Token': extractCookie(res.headers['set-cookie'], 'openestate_csrf') };
    return { agent, auth };
  }

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const manager = await makeStaff('manage', [
      PERMISSIONS.POSTSALES_INTEREST_MANAGE,
      PERMISSIONS.ADMIN_MASTER_READ,
      PERMISSIONS.ADMIN_MASTER_UPDATE,
      PERMISSIONS.ADMIN_MASTER_DELETE,
    ]);
    emails.manage = manager.email;
    managerId = manager.id;
    emails.accounts = (await makeStaff('accounts', [PERMISSIONS.POSTSALES_INTEREST_MANAGE])).email;
    emails.masters = (await makeStaff('masters', [PERMISSIONS.ADMIN_MASTER_READ])).email;
    emails.waive = (await makeStaff('waive', [PERMISSIONS.POSTSALES_INTEREST_WAIVE])).email;
    emails.none = (await makeStaff('none', [PERMISSIONS.POSTSALES_BOOKING_READ])).email;

    const mk = async (name: string, rateType: string) =>
      (
        await systemPrisma.interestRule.create({
          data: { companyId: fx.companyId, name: `${name} ${TAG}`, rateType, ratePercent: 18, frequency: 'YEARLY' },
        })
      ).id;
    simpleRuleId = await mk('Simple 18', 'SIMPLE');
    compoundRuleId = await mk('Compound 18', 'COMPOUND');
    spareRuleId = await mk('Spare 18', 'SIMPLE');
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('attachable lookup: Accounts can select rules without master-read', async () => {
    const { agent, auth } = await login(emails.accounts);
    await agent.get('/api/v1/masters/interest-rules').set(auth).expect(403);
    const res = await agent.get('/api/v1/bookings/interest-rules/attachable').set(auth).expect(200);
    expect(res.body).toEqual({ data: [
      { id: simpleRuleId, name: `Simple 18 ${TAG}`, ratePercent: '18' },
      { id: spareRuleId, name: `Spare 18 ${TAG}`, ratePercent: '18' },
    ] });
  });

  it('attachable lookup: ignores caller company scope and excludes every ineligible rule', async () => {
    const other = await seedCompany(systemPrisma);
    try {
      await systemPrisma.interestRule.createMany({ data: [
        { companyId: other.companyId, name: 'Foreign', rateType: 'SIMPLE', ratePercent: 12, frequency: 'YEARLY' },
        { companyId: fx.companyId, name: 'Inactive simple', rateType: 'SIMPLE', isActive: false, ratePercent: 12, frequency: 'YEARLY' },
        { companyId: fx.companyId, name: 'Inactive compound', rateType: 'COMPOUND', isActive: false, ratePercent: 12, frequency: 'YEARLY' },
      ] });
      const { agent, auth } = await login(emails.accounts);
      const res = await agent.get('/api/v1/bookings/interest-rules/attachable')
        .query({ companyId: other.companyId }).set(auth).expect(200);
      expect(res.body.data.map((rule: { id: string }) => rule.id)).toEqual([simpleRuleId, spareRuleId]);
    } finally {
      await cleanupCompany(systemPrisma, other.companyId);
    }
  });

  it('attachable lookup: refuses callers without manage', async () => {
    for (const email of [emails.none, emails.waive, emails.masters]) {
      const { agent, auth } = await login(email);
      await agent.get('/api/v1/bookings/interest-rules/attachable').set(auth).expect(403);
      if (email === emails.masters) {
        await agent.get('/api/v1/masters/interest-rules').set(auth).expect(200);
      }
    }
    await request(app.getHttpServer()).get('/api/v1/bookings/interest-rules/attachable').expect(401);
  });

  it('attaches a rule (manage), writes an audit row with the actor, and charges nothing before the attach date', async () => {
    const bookingId = await overdueBooking();
    const { agent, auth } = await login(emails.manage);

    const res = await agent
      .put(`/api/v1/bookings/${bookingId}/interest-rule`)
      .set(auth)
      .send({ interestRuleId: simpleRuleId })
      .expect(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.body).toMatchObject({ bookingId, interestRuleId: simpleRuleId, interestFromDate: today, settledPaise: '0' });

    const row = await systemPrisma.booking.findUnique({ where: { id: bookingId } });
    expect(row.interestRuleId).toBe(simpleRuleId);

    const audit = await systemPrisma.auditLog.findFirst({
      where: { companyId: fx.companyId, entityId: bookingId, action: 'INTEREST_RULE_SET' },
    });
    expect(audit).not.toBeNull();
    expect(audit.userId).toBe(managerId);
    expect(audit.entityType).toBe('Booking');
    expect(audit.ipAddress).toBeTruthy();
    expect(audit.before).toMatchObject({ interestRuleId: null });
    expect(audit.after).toMatchObject({
      interestRuleId: simpleRuleId,
      ruleName: `Simple 18 ${TAG}`,
      rateType: 'SIMPLE',
      ratePercent: '18',
      interestFromDate: today,
      settledPaise: '0',
      permission: 'postsales.interest.manage',
    });

    // The installment has been overdue since 2026-01-01, but interest runs
    // only from today.
    const accrued = await agent.post(`/api/v1/bookings/${bookingId}/interest/accrue`).set(auth).expect(201);
    expect(accrued.body.postedPaise).toBe('0');
  });

  it('attached rule display: booking readers retain minimal rule details after deactivation and lose them on removal', async () => {
    const bookingId = await overdueBooking();
    const rule = await systemPrisma.interestRule.create({ data: {
      companyId: fx.companyId, name: 'Annual Delay 18%', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY',
    } });
    const manager = await login(emails.accounts);
    const reader = await login(emails.none);
    await manager.agent.put(`/api/v1/bookings/${bookingId}/interest-rule`).set(manager.auth).send({ interestRuleId: rule.id }).expect(200);
    const expected = { id: rule.id, name: rule.name, ratePercent: '18', rateType: 'SIMPLE' };
    const active = await reader.agent.get(`/api/v1/bookings/${bookingId}`).set(reader.auth).expect(200);
    expect(active.body.attachedInterestRule).toEqual(expected);
    await systemPrisma.interestRule.update({ where: { id: rule.id }, data: { isActive: false } });
    const inactive = await reader.agent.get(`/api/v1/bookings/${bookingId}`).set(reader.auth).expect(200);
    expect(inactive.body.attachedInterestRule).toEqual(expected);
    expect(inactive.body.interestFromDate).toBe(active.body.interestFromDate);
    const choices = await manager.agent.get('/api/v1/bookings/interest-rules/attachable').set(manager.auth).expect(200);
    expect(choices.body.data.some((r: { id: string }) => r.id === rule.id)).toBe(false);
    await manager.agent.get(`/api/v1/bookings/${bookingId}`).set(manager.auth).expect(403);
    await manager.agent.put(`/api/v1/bookings/${bookingId}/interest-rule`).set(manager.auth).send({ interestRuleId: null }).expect(200);
    const removed = await reader.agent.get(`/api/v1/bookings/${bookingId}`).set(reader.auth).expect(200);
    expect(removed.body.attachedInterestRule).toBeNull();
    expect(removed.body.interestFromDate).toBeNull();
  });

  it('attached rule display: a booking reader cannot retrieve another company booking or its rule', async () => {
    const other = await seedCompany(systemPrisma);
    try {
      const unitId = await makeUnit(systemPrisma, other);
      const applicantId = await makeApplicant(systemPrisma, other.companyId);
      const rule = await systemPrisma.interestRule.create({ data: {
        companyId: other.companyId, name: 'Foreign attached rule', rateType: 'SIMPLE', ratePercent: 24, frequency: 'YEARLY', isActive: false,
      } });
      const booking = await systemPrisma.booking.create({ data: {
        companyId: other.companyId, unitId, primaryApplicantId: applicantId, bookingNumber: `FOREIGN-${TAG}`,
        status: 'BOOKED', agreedPricePaise: 10000n, bookingDate: new Date(), interestRuleId: rule.id,
      } });
      const reader = await login(emails.none);
      await reader.agent.get(`/api/v1/bookings/${booking.id}`).query({ companyId: other.companyId })
        .set(reader.auth).set('X-Company-Id', other.companyId).expect(404);
    } finally {
      await cleanupCompany(systemPrisma, other.companyId);
    }
  });

  it('refuses the change without postsales.interest.manage (403), even with waive', async () => {
    const bookingId = await overdueBooking();
    for (const email of [emails.waive, emails.none]) {
      const { agent, auth } = await login(email);
      await agent.put(`/api/v1/bookings/${bookingId}/interest-rule`).set(auth).send({ interestRuleId: simpleRuleId }).expect(403);
    }
    expect((await systemPrisma.booking.findUnique({ where: { id: bookingId } })).interestRuleId).toBeNull();
  });

  it('manual accrue accepts manage or waive, and refuses neither', async () => {
    const bookingId = await overdueBooking();
    for (const email of [emails.manage, emails.waive]) {
      const { agent, auth } = await login(email);
      await agent.post(`/api/v1/bookings/${bookingId}/interest/accrue`).set(auth).expect(201);
    }
    const { agent, auth } = await login(emails.none);
    await agent.post(`/api/v1/bookings/${bookingId}/interest/accrue`).set(auth).expect(403);
  });

  it('refuses a COMPOUND rule with a clear 409', async () => {
    const bookingId = await overdueBooking();
    const { agent, auth } = await login(emails.manage);
    const res = await agent
      .put(`/api/v1/bookings/${bookingId}/interest-rule`)
      .set(auth)
      .send({ interestRuleId: compoundRuleId })
      .expect(409);
    expect(res.body.message).toMatch(/simple/i);
    expect((await systemPrisma.booking.findUnique({ where: { id: bookingId } })).interestRuleId).toBeNull();
  });

  it('master guard: a rule in use keeps its rate; other edits still work', async () => {
    const bookingId = await overdueBooking();
    const { agent, auth } = await login(emails.manage);
    await agent.put(`/api/v1/bookings/${bookingId}/interest-rule`).set(auth).send({ interestRuleId: spareRuleId }).expect(200);

    const refused = await agent
      .patch(`/api/v1/masters/interest-rules/${spareRuleId}`)
      .set(auth)
      .send({ ratePercent: 30 })
      .expect(409);
    expect(refused.body.message).toMatch(/attached to 1 booking/);
    await agent.patch(`/api/v1/masters/interest-rules/${spareRuleId}`).set(auth).send({ rateType: 'COMPOUND' }).expect(409);
    expect(Number((await systemPrisma.interestRule.findUnique({ where: { id: spareRuleId } })).ratePercent)).toBe(18);

    // The Masters screen sends the whole record: unchanged rate fields pass.
    await agent
      .patch(`/api/v1/masters/interest-rules/${spareRuleId}`)
      .set(auth)
      .send({ name: `Spare renamed ${TAG}`, rateType: 'SIMPLE', ratePercent: 18 })
      .expect(200);

    // A rule nobody uses can still be re-rated.
    await agent.patch(`/api/v1/masters/interest-rules/${compoundRuleId}`).set(auth).send({ ratePercent: 20 }).expect(200);
  });

  it('a rule attached to a booking cannot be deleted (ON DELETE RESTRICT, plain 409)', async () => {
    const bookingId = await overdueBooking();
    const attached = (
      await systemPrisma.interestRule.create({
        data: { companyId: fx.companyId, name: `Attached ${TAG}`, rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
      })
    ).id;
    const { agent, auth } = await login(emails.manage);
    await agent.put(`/api/v1/bookings/${bookingId}/interest-rule`).set(auth).send({ interestRuleId: attached }).expect(200);

    const res = await agent.delete(`/api/v1/masters/interest-rules/${attached}`).set(auth).expect(409);
    expect(res.body.message).toMatch(/attached to a booking/i);
    expect(await systemPrisma.interestRule.count({ where: { id: attached } })).toBe(1);
    expect((await systemPrisma.booking.findUnique({ where: { id: bookingId } })).interestRuleId).toBe(attached);

    const [fk] = await systemPrisma.$queryRawUnsafe(
      `SELECT confdeltype, convalidated FROM pg_constraint WHERE conname = 'bookings_interest_rule_id_fkey'`,
    );
    expect(fk).toEqual({ confdeltype: 'r', convalidated: true });
  });
  it('attach: another company\'s rule is not found (404), and the booking is unchanged', async () => {
    const other = await seedCompany(systemPrisma);
    try {
      const foreign = await systemPrisma.interestRule.create({ data: {
        companyId: other.companyId, name: 'Foreign active', rateType: 'SIMPLE', ratePercent: 12, frequency: 'YEARLY',
      } });
      const bookingId = await overdueBooking();
      const { agent, auth } = await login(emails.manage);
      await agent.put(`/api/v1/bookings/${bookingId}/interest-rule`).set(auth)
        .set('X-Company-Id', other.companyId).send({ interestRuleId: foreign.id }).expect(404);
      expect((await systemPrisma.booking.findUnique({ where: { id: bookingId } })).interestRuleId).toBeNull();
      expect(await systemPrisma.auditLog.count({ where: { entityId: bookingId, action: 'INTEREST_RULE_SET' } })).toBe(0);
    } finally {
      await cleanupCompany(systemPrisma, other.companyId);
    }
  });

  it('attached rule display: a stored rule id from another company is never shown', async () => {
    const other = await seedCompany(systemPrisma);
    const bookingId = await overdueBooking();
    try {
      const foreign = await systemPrisma.interestRule.create({ data: {
        companyId: other.companyId, name: 'Foreign leaked name', rateType: 'SIMPLE', ratePercent: 31, frequency: 'YEARLY',
      } });
      // Only reachable by writing the column directly; the API never allows it.
      await systemPrisma.booking.update({ where: { id: bookingId }, data: { interestRuleId: foreign.id } });
      const reader = await login(emails.none);
      const res = await reader.agent.get(`/api/v1/bookings/${bookingId}`).set(reader.auth).expect(200);
      expect(res.body.attachedInterestRule).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('Foreign leaked name');
    } finally {
      await systemPrisma.booking.update({ where: { id: bookingId }, data: { interestRuleId: null } });
      await cleanupCompany(systemPrisma, other.companyId);
    }
  });

  it('manual grant (v0.9 release notes): a Super Admin grants manage in Roles; a Company Admin without it cannot', async () => {
    const keysOf = async (roleId: string) =>
      (await systemPrisma.rolePermission.findMany({ where: { roleId }, include: { permission: true } }))
        .map((rp: { permission: { key: string } }) => rp.permission.key).sort();
    const systemRole = async (slug: string, keys: string[]) => {
      const role = await systemPrisma.role.create({ data: { companyId: fx.companyId, name: slug, slug, isSystem: true } });
      const perms = await systemPrisma.permission.findMany({ where: { key: { in: keys } } });
      await systemPrisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
      return role.id as string;
    };
    const userIn = async (roleId: string, label: string) => {
      const email = `e2e-ir-grant-${label}-${TAG}@test.com`;
      await systemPrisma.user.create({ data: {
        companyId: fx.companyId, email, name: label, roleId, forcePasswordChange: false,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
      } });
      return email;
    };
    // The state a v0.8.3 install is left in: no system role but super_admin holds it.
    const accountsKeys = [PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.POSTSALES_INTEREST_WAIVE];
    const accountsRole = await systemRole('accounts', accountsKeys);
    const adminRole = await systemRole('company_admin', [PERMISSIONS.ADMIN_ROLE_READ, PERMISSIONS.ADMIN_ROLE_UPDATE, ...accountsKeys]);
    const superRole = await systemRole('super_admin', [...ALL_PERMISSIONS]);
    const accountsUser = await userIn(accountsRole, 'accounts');
    const all = await systemPrisma.permission.findMany({ where: { key: { in: [...accountsKeys, PERMISSIONS.POSTSALES_INTEREST_MANAGE] } } });
    const body = { permissionIds: all.map((p: { id: string }) => p.id) };

    const before = await login(accountsUser);
    await before.agent.get('/api/v1/bookings/interest-rules/attachable').set(before.auth).expect(403);

    const admin = await login(await userIn(adminRole, 'admin'));
    await admin.agent.patch(`/api/v1/roles/${accountsRole}`).set(admin.auth).send(body).expect(403);
    expect(await keysOf(accountsRole)).not.toContain(PERMISSIONS.POSTSALES_INTEREST_MANAGE);

    const sup = await login(await userIn(superRole, 'super'));
    await sup.agent.patch(`/api/v1/roles/${accountsRole}`).set(sup.auth).send(body).expect(200);
    expect(await keysOf(accountsRole)).toContain(PERMISSIONS.POSTSALES_INTEREST_MANAGE);
    expect(await systemPrisma.auditLog.count({ where: { entityId: accountsRole, action: 'ROLE_PERMS_CHANGED' } })).toBe(1);

    // "To check": the role's users can now choose a rule, without signing in again.
    const refreshed = await before.agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', before.auth['X-CSRF-Token']).expect(200);
    await before.agent.get('/api/v1/bookings/interest-rules/attachable')
      .set({ ...before.auth, Authorization: `Bearer ${refreshed.body.accessToken}` }).expect(200);
  });
});
