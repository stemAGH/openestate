/**
 * Phone numbers in list views (CLAUDE.md: "mask PAN/phone in list views and
 * logs"): every list response shows only the last 4 digits; detail
 * responses and CSV exports keep the full number; CSV exports need
 * presales.report.export and write an audit row; search by phone still
 * matches server-side.
 *
 * "Full number anywhere" is checked on the raw response text: no run of 7+
 * digits from any seeded phone may appear in a list body.
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
import { ALL_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { makeClients, makeUnit, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PASSWORD = 'StaffPass123';
const TAG = `${Date.now()}-${process.pid}`;
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-phone-masking-${TAG}-`;

// Distinct numbers per run (applicant phones are deduplicated per company).
const suffix = String(Date.now()).slice(-5);
const PHONES = {
  lead: `97${suffix}123`, // 10 digits: 97 + 5 + 3
  dup: `96${suffix}456`,
  broker: `95${suffix}789`,
  staff: `94${suffix}012`,
  alt: `93${suffix}345`,
};
const last4 = (p: string) => `••••••${p.slice(-4)}`;

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

describeIf('e2e phone masking in list responses, full numbers in detail and CSV exports', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  const ids: Record<string, string> = {};
  const tokens = new Map<string, string>();
  const email = (who: string) => `e2e-mask-${who}-${TAG}@test.com`;

  const csrf = new Map<string, { token: string; cookie: string }>();
  async function token(who: string) {
    if (!tokens.has(who)) {
      const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: email(who), password: PASSWORD }).expect(200);
      tokens.set(who, res.body.accessToken);
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      csrf.set(who, {
        token: /openestate_csrf=([^;]+)/.exec(cookies.join(';'))?.[1] ?? '',
        cookie: cookies.map((c) => c.split(';')[0]).join('; '),
      });
    }
    return tokens.get(who)!;
  }
  async function get(who: string, path: string, status = 200) {
    const res = await request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${await token(who)}`);
    expect(res.status, `${path}: ${res.text.slice(0, 300)}`).toBe(status);
    return res;
  }
  async function post(who: string, path: string, body: object) {
    const t = await token(who);
    const c = csrf.get(who)!;
    return request(app.getHttpServer()).post(`/api/v1${path}`).set('Authorization', `Bearer ${t}`).set('X-CSRF-Token', c.token).set('Cookie', c.cookie).send(body);
  }
  /** The text with spaces and hyphens removed, so "+91 97588 89123" is found as digits. */
  const squash = (text: string) => text.replace(/[\s-]/g, '');
  const hasFull = (text: string, p: string) => squash(text).includes(p.slice(-7));
  /** No seeded phone number appears in full anywhere in the body, in any formatting. */
  function expectNoFullPhone(text: string) {
    for (const p of Object.values(PHONES)) expect(hasFull(text, p), `full ${p.slice(0, 2)}… number in body`).toBe(false);
  }

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    for (const key of ALL_PERMISSIONS) await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    const permByKey = new Map((await systemPrisma.permission.findMany()).map((p: { key: string; id: string }) => [p.key, p.id]));
    const mkRole = async (slug: string, keys: readonly string[]) => {
      const role = await systemPrisma.role.create({ data: { companyId: fx.companyId, name: `${slug} ${TAG}`, slug } });
      await systemPrisma.rolePermission.createMany({ data: keys.map((k) => ({ roleId: role.id, permissionId: permByKey.get(k) })) });
      return role.id;
    };
    const hash = await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id });
    const mkUser = async (who: string, roleId: string, extra: Record<string, unknown> = {}) =>
      (await systemPrisma.user.create({ data: { companyId: fx.companyId, email: email(who), name: `User ${who}`, passwordHash: hash, roleId, forcePasswordChange: false, ...extra } })).id;

    // company_admin must carry the real slug (TeamScopeService keys admin-tier off it).
    ids.admin = await mkUser('admin', await mkRole(SYSTEM_ROLES.COMPANY_ADMIN, ROLE_PERMISSIONS[SYSTEM_ROLES.COMPANY_ADMIN]), { phone: PHONES.staff });
    ids.mgr = await mkUser('mgr', await mkRole(`mgr-${TAG}`, ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER]));
    ids.exec = await mkUser('exec', await mkRole(`exec-${TAG}`, ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]), { managerId: ids.mgr });
    ids.peer = await mkUser('peer', await mkRole(`peer-${TAG}`, ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]));
    // Views every report on screen, but may not export.
    await mkUser('viewer', await mkRole(`viewer-${TAG}`, [
      PERMISSIONS.PRESALES_REPORT_VIEW, PERMISSIONS.REPORTS_BIRTHDAY_VIEW, PERMISSIONS.REPORTS_BROKER_VIEW,
      PERMISSIONS.PRESALES_INQUIRY_READ,
    ]));

    // The lead, stored the way people type it; born today (birthday list).
    const lead = await systemPrisma.applicant.create({
      data: {
        companyId: fx.companyId, name: `Mask Lead ${TAG}`, primaryPhone: `+91 ${PHONES.lead.slice(0, 5)} ${PHONES.lead.slice(5)}`,
        primaryPhoneNormalized: PHONES.lead, alternatePhones: [PHONES.alt], email: `lead-${TAG}@example.in`,
        dateOfBirth: new Date(Date.UTC(1990, new Date().getMonth(), new Date().getDate())),
      },
    });
    ids.lead = lead.id;
    const inq = await systemPrisma.inquiry.create({
      data: { companyId: fx.companyId, applicantId: lead.id, assignedToId: ids.exec, status: 'OPEN', nextFollowupAt: new Date(Date.now() - 86_400_000) },
    });
    ids.inquiry = inq.id;
    // Two applicants sharing one number: a duplicate pair.
    for (const n of ['A', 'B']) {
      const a = await systemPrisma.applicant.create({ data: { companyId: fx.companyId, name: `Mask Dup ${n} ${TAG}`, primaryPhone: PHONES.dup, primaryPhoneNormalized: PHONES.dup } });
      ids[`dup${n}`] = a.id;
    }
    const broker = await systemPrisma.broker.create({ data: { companyId: fx.companyId, name: `Mask Broker ${TAG}`, phone: PHONES.broker } });
    ids.broker = broker.id;
    const booking = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId, unitId: await makeUnit(systemPrisma, fx), primaryApplicantId: lead.id,
        bookingNumber: `MASK-${TAG}`, agreedPricePaise: 20_00_000_00n, bookingDate: new Date('2026-06-01'), brokerId: broker.id,
      },
    });
    ids.booking = booking.id;
    await systemPrisma.commissionLedgerEntry.create({
      data: { companyId: fx.companyId, brokerId: broker.id, bookingId: booking.id, entryType: 'ACCRUAL', signedAmountPaise: 50_000_00n, effectiveDate: new Date() },
    });
    await systemPrisma.communicationLog.createMany({
      data: [
        { companyId: fx.companyId, applicantId: lead.id, channel: 'SMS', toAddress: PHONES.lead, body: 'Hello' },
        { companyId: fx.companyId, applicantId: lead.id, channel: 'EMAIL', toAddress: `lead-${TAG}@example.in`, body: 'Hello' },
      ],
    });
    await systemPrisma.documentDispatch.createMany({
      data: [
        { companyId: fx.companyId, applicantId: lead.id, bookingId: booking.id, channel: 'SMS', recipientAddress: PHONES.lead, templateSnapshot: 'x' },
        { companyId: fx.companyId, applicantId: lead.id, bookingId: booking.id, channel: 'EMAIL', recipientAddress: `lead-${TAG}@example.in`, templateSnapshot: 'x' },
      ],
    });
    await systemPrisma.applicantChangeRequest.create({
      data: { companyId: fx.companyId, applicantId: lead.id, requestedById: ids.admin, fieldChanges: { alternatePhones: { from: [PHONES.alt], to: [PHONES.dup] } } },
    });
  });

  afterAll(async () => {
    await app?.close();
    if (fx) await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma?.$disconnect();
  });

  describe('lists show the last 4 digits only', () => {
    it('GET /inquiries', async () => {
      const res = await get('exec', '/inquiries');
      const row = res.body.data.find((i: { id: string }) => i.id === ids.inquiry);
      expect(row.applicant.primaryPhone).toBe(last4(PHONES.lead));
      expect(row.applicant.primaryPhoneNormalized).toBe(last4(PHONES.lead));
      expect(row.applicant.alternatePhones).toEqual([last4(PHONES.alt)]);
      expectNoFullPhone(res.text);
    });

    it('GET /inquiries/my-day', async () => {
      const res = await get('exec', '/inquiries/my-day');
      expect(res.body.find((i: { id: string }) => i.id === ids.inquiry).applicant.primaryPhone).toBe(last4(PHONES.lead));
      expectNoFullPhone(res.text);
    });

    it('GET /applicants', async () => {
      const res = await get('admin', '/applicants?limit=100');
      expect(res.body.data.find((a: { id: string }) => a.id === ids.lead).primaryPhone).toBe(last4(PHONES.lead));
      expectNoFullPhone(res.text);
    });

    it('GET /applicants/:id/duplicates', async () => {
      const res = await get('admin', `/applicants/${ids.dupA}/duplicates`);
      expect(res.body.map((a: { id: string }) => a.id)).toEqual([ids.dupB]);
      expect(res.body[0].primaryPhone).toBe(last4(PHONES.dup));
      expectNoFullPhone(res.text);
    });

    it('POST /inquiries possibleDuplicates', async () => {
      const res = await post('admin', '/inquiries', { applicant: { name: `Mask New ${TAG}`, primaryPhone: PHONES.dup } });
      expect(res.status, res.text).toBe(201);
      expect(res.body.possibleDuplicates.length).toBeGreaterThan(0);
      for (const d of res.body.possibleDuplicates) expect(d.primaryPhone).toBe(last4(PHONES.dup));
      // The new inquiry's own applicant number is the caller's own input; only the candidates are a list.
      expect(hasFull(JSON.stringify(res.body.possibleDuplicates), PHONES.dup)).toBe(false);
    });

    it('GET /brokers', async () => {
      const res = await get('admin', '/brokers?limit=100');
      expect(res.body.data.find((b: { id: string }) => b.id === ids.broker).phone).toBe(last4(PHONES.broker));
      expectNoFullPhone(res.text);
    });

    it('GET /users', async () => {
      const res = await get('admin', '/users?limit=100');
      expect(res.body.data.find((u: { id: string }) => u.id === ids.admin).phone).toBe(last4(PHONES.staff));
      expectNoFullPhone(res.text);
    });

    it('GET /audit masks before/after in the response; the stored row keeps the full number', async () => {
      const created = await post('admin', '/applicants', { name: `Mask Audit ${TAG}`, primaryPhone: PHONES.alt });
      expect(created.status, created.text).toBe(201);
      const res = await get('admin', '/audit?limit=100');
      const row = res.body.data.find((r: { entityType: string; after: { name?: string } | null }) => r.entityType === 'Applicant' && r.after?.name === `Mask Audit ${TAG}`);
      expect(row, 'audit row for the created applicant').toBeTruthy();
      expect(row.after.primaryPhone).toBe(last4(PHONES.alt));
      expectNoFullPhone(res.text);
      const stored = await systemPrisma.auditLog.findUnique({ where: { id: row.id } });
      expect(stored.after.primaryPhone).toBe(PHONES.alt);
    });

    it('GET /applicants/:id/communications masks SMS recipients only', async () => {
      const res = await get('admin', `/applicants/${ids.lead}/communications`);
      const by = (c: string) => res.body.find((r: { channel: string }) => r.channel === c);
      expect(by('SMS').toAddress).toBe(last4(PHONES.lead));
      expect(by('EMAIL').toAddress).toBe(`lead-${TAG}@example.in`);
      expectNoFullPhone(res.text);
    });

    it.each(['applicants', 'bookings'])('GET /%s/:id/dispatch-history masks SMS recipients only', async (base) => {
      const res = await get('admin', `/${base}/${base === 'applicants' ? ids.lead : ids.booking}/dispatch-history`);
      const by = (c: string) => res.body.find((r: { channel: string }) => r.channel === c);
      expect(by('SMS').recipientAddress).toBe(last4(PHONES.lead));
      expect(by('EMAIL').recipientAddress).toBe(`lead-${TAG}@example.in`);
      expectNoFullPhone(res.text);
    });

    it('GET /admin/change-requests masks phone changes', async () => {
      const res = await get('admin', '/admin/change-requests');
      const row = res.body.find((r: { applicantId: string }) => r.applicantId === ids.lead);
      expect(row.fieldChanges.alternatePhones).toEqual({ from: [last4(PHONES.alt)], to: [last4(PHONES.dup)] });
      expectNoFullPhone(res.text);
    });
  });

  describe('details keep the full number', () => {
    it.each([
      ['exec', () => `/inquiries/${ids.inquiry}`, (b: { applicant: { primaryPhoneNormalized: string } }) => b.applicant.primaryPhoneNormalized, 'lead'],
      ['admin', () => `/applicants/${ids.lead}`, (b: { primaryPhoneNormalized: string }) => b.primaryPhoneNormalized, 'lead'],
      ['admin', () => `/applicants/${ids.lead}/360`, (b: { applicant: { primaryPhoneNormalized: string } }) => b.applicant.primaryPhoneNormalized, 'lead'],
      ['admin', () => `/brokers/${ids.broker}`, (b: { phone: string }) => b.phone, 'broker'],
      ['admin', () => `/users/${ids.admin}`, (b: { phone: string }) => b.phone, 'staff'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as Array<[string, () => string, (b: any) => string, keyof typeof PHONES]>)('%s %s', async (who, path, pick, phone) => {
      const res = await get(who, path());
      expect(pick(res.body)).toBe(PHONES[phone]);
    });

    it('the detail endpoint the Call/WhatsApp buttons use stays team-scoped', async () => {
      await get('peer', `/inquiries/${ids.inquiry}`, 404);
    });
  });

  describe('search by phone still matches server-side', () => {
    it('inquiries, applicants and brokers find the row by its full number, returned masked', async () => {
      const q = encodeURIComponent(`+91 ${PHONES.lead.slice(0, 5)} ${PHONES.lead.slice(5)}`);
      const inq = await get('exec', `/inquiries?search=${q}`);
      expect(inq.body.data.map((i: { id: string }) => i.id)).toEqual([ids.inquiry]);
      const apps = await get('admin', `/applicants?search=${PHONES.lead.slice(5)}`);
      expect(apps.body.data.map((a: { id: string }) => a.id)).toContain(ids.lead);
      const br = await get('admin', `/brokers?search=${PHONES.broker}`);
      expect(br.body.data.map((b: { id: string }) => b.id)).toEqual([ids.broker]);
      for (const r of [inq, apps, br]) expectNoFullPhone(r.text);
    });
  });

  describe('reports: on-screen JSON masked under view; CSV full, export permission, audit row', () => {
    const REPORTS = [
      // Who views it on screen without the export permission: the lead's own salesperson for the
      // team-scoped inquiries export, a view-only role for the other two.
      { key: 'inquiries-export', path: '/reports/presales/inquiries-export', phone: 'lead' as const, entity: 'PresalesReport', viewer: 'exec' },
      { key: 'birthday-list', path: '/reports/postsales/birthday-list', phone: 'lead' as const, entity: 'PostsalesReport', viewer: 'viewer' },
      { key: 'dues', path: '/reports/brokers/dues', phone: 'broker' as const, entity: 'BrokerReport', viewer: 'viewer' },
    ];

    for (const r of REPORTS) {
      it(`${r.key}: JSON under view only, masked`, async () => {
        const res = await get(r.viewer, r.path);
        expect(res.text).toContain(last4(PHONES[r.phone]));
        expectNoFullPhone(res.text);
      });

      it(`${r.key}: CSV without presales.report.export is a 403`, async () => {
        await get(r.viewer, `${r.path}?format=csv`, 403);
      });

      it(`${r.key}: CSV with the export permission has the full number and writes an audit row`, async () => {
        const before = await systemPrisma.auditLog.count({ where: { companyId: fx.companyId, action: 'EXPORT', entityType: r.entity, entityId: r.key } });
        const res = await get('admin', `${r.path}?format=csv`);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(hasFull(res.text, PHONES[r.phone])).toBe(true);
        const after = await systemPrisma.auditLog.findMany({ where: { companyId: fx.companyId, action: 'EXPORT', entityType: r.entity, entityId: r.key }, orderBy: { createdAt: 'desc' } });
        expect(after.length).toBe(before + 1);
        expect(after[0].userId).toBe(ids.admin);
      });
    }

    it.each(['sold-units', 'commission-summary', `:broker/customer-detail`])('broker %s CSV also needs the export permission', async (p) => {
      const path = `/reports/brokers/${p.replace(':broker', ids.broker)}`;
      await get('viewer', `${path}?format=csv`, 403);
      await get('admin', `${path}?format=csv`);
      await get('viewer', path); // the on-screen JSON stays on its view permission
    });
  });
});
