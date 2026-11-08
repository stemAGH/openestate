/**
 * v0.7.1: audit rows through the real HTTP pipeline, one or more requests
 * per module group that used the lossy `withTenantTx(..., (tx) =>
 * tx.model.op(...))` form.
 *
 * Before the fix these writes left NO audit row: the Prisma query is a
 * lazy thenable, it ran after `tenantTxContext.run()` had exited, and the
 * audit hook silently skipped it. Rows that were written had no actor,
 * because services wrap their own bare `runWithTenant({ companyId })`,
 * which shadowed the request's userId and IP.
 *
 * Loads the compiled dist/ AppModule — the same code production runs.
 * (Reproduced both under vitest and in plain Node before this file was
 * written: `POST /custom-fields` returned 201 and wrote 0 audit rows.)
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
import { ALL_PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import {
  makeClients,
  seedCompany,
  cleanupCompany,
  buildServices,
  makeUnit,
  makeApplicant,
  makeBroker,
  makeFlatCommissionRule,
  type CompanyFixture,
  type Services,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

// main.ts patches this; tests that load dist/ must too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function (this: bigint) {
  return this.toString();
};

const STAFF_PASSWORD = 'StaffPass123';
const TAG = Date.now();

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

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

describeIf('e2e audit rows: every write is audited, with the acting user', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;
  let svc: Services;
  let adminId: string;
  let adminRoleId: string;
  let session: { agent: ReturnType<typeof request.agent>; csrf: string; token: string };

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);

    for (const key of ALL_PERMISSIONS) {
      await systemPrisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await systemPrisma.permission.findMany();
    const role = await systemPrisma.role.create({
      data: { companyId: fx.companyId, name: 'E2E Audit Admin', slug: `e2e_audit_${TAG}`, isSystem: true },
    });
    adminRoleId = role.id;
    await systemPrisma.rolePermission.createMany({
      data: allPerms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })),
    });
    const email = `e2e-audit-${TAG}@test.com`;
    const admin = await systemPrisma.user.create({
      data: {
        companyId: fx.companyId,
        email,
        passwordHash: await argon2.hash(STAFF_PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Audit Admin',
        roleId: role.id,
        forcePasswordChange: false,
      },
    });
    adminId = admin.id;

    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ email, password: STAFF_PASSWORD }).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    session = { agent, csrf: /openestate_csrf=([^;]+)/.exec(cookies.join(';'))![1], token: res.body.accessToken };
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  const send = (method: 'post' | 'patch', url: string, body: unknown = {}) =>
    session.agent[method](`/api/v1${url}`)
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrf)
      .send(body as object);

  /** The newest audit row for this entity + action, asserted to name the admin. */
  async function expectAuditedByAdmin(entityType: string, entityId: string, action: 'CREATE' | 'UPDATE' | 'DELETE') {
    const rows = await systemPrisma.auditLog.findMany({
      where: { companyId: fx.companyId, entityType, entityId, action },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows.length, `${action} ${entityType} ${entityId} has an audit row`).toBeGreaterThanOrEqual(1);
    expect(rows[0].userId, `${action} ${entityType}: actor is the admin`).toBe(adminId);
    expect(rows[0].ipAddress, `${action} ${entityType}: IP recorded`).toBeTruthy();
    return rows[0];
  }

  async function bookingFor(brokerId?: string) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000_00n, gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    if (brokerId) await systemPrisma.booking.update({ where: { id: booking.id }, data: { brokerId } });
    return booking;
  }

  it('custom fields: create and update', async () => {
    const created = await send('post', '/custom-fields', { entityType: 'APPLICANT', key: `k_${TAG}`, label: 'K', fieldType: 'TEXT' }).expect(201);
    await expectAuditedByAdmin('CustomFieldDefinition', created.body.id, 'CREATE');
    await send('patch', `/custom-fields/${created.body.id}`, { label: 'K2' }).expect(200);
    await expectAuditedByAdmin('CustomFieldDefinition', created.body.id, 'UPDATE');
  });

  it('users: create and deactivate — and no password hash lands in the row', async () => {
    const created = await send('post', '/users', {
      email: `new-${TAG}@test.com`, name: 'New User', password: 'AnotherPass1234', roleId: adminRoleId,
    }).expect(201);
    const row = await expectAuditedByAdmin('User', created.body.id, 'CREATE');
    expect(JSON.stringify(row.after)).not.toContain('$argon2');
    await send('post', `/users/${created.body.id}/deactivate`).expect(200);
    await expectAuditedByAdmin('User', created.body.id, 'UPDATE');
  });

  it('applicants: create, update, consent', async () => {
    const created = await send('post', '/applicants', { name: 'Audit Applicant', primaryPhone: phone() }).expect(201);
    await expectAuditedByAdmin('Applicant', created.body.id, 'CREATE');
    await send('patch', `/applicants/${created.body.id}`, { city: 'Pune' }).expect(200);
    await expectAuditedByAdmin('Applicant', created.body.id, 'UPDATE');
    const consent = await send('post', `/applicants/${created.body.id}/consent`, { given: true }).expect(201);
    await expectAuditedByAdmin('ApplicantConsent', consent.body.id, 'CREATE');
  });

  it('inventory: project create/update, tower update, unit update', async () => {
    const project = await send('post', '/projects', { name: `Audit Project ${TAG}`, code: `AP${TAG}` }).expect(201);
    await expectAuditedByAdmin('Project', project.body.id, 'CREATE');
    await send('patch', `/projects/${project.body.id}`, { description: 'x' }).expect(200);
    await expectAuditedByAdmin('Project', project.body.id, 'UPDATE');

    await send('patch', `/projects/${fx.projectId}/towers/${fx.towerId}`, { name: 'Tower Renamed' }).expect(200);
    await expectAuditedByAdmin('Tower', fx.towerId, 'UPDATE');

    const unitId = await makeUnit(systemPrisma, fx);
    await send('patch', `/projects/${fx.projectId}/units/${unitId}`, { carpetAreaSqft: 900 }).expect(200);
    await expectAuditedByAdmin('Unit', unitId, 'UPDATE');
  });

  it('brokers: create (PAN redacted), deactivate, commission rule, assign to booking', async () => {
    const created = await send('post', '/brokers', { name: 'Audit Broker', phone: phone(), pan: 'ABCDE1234F' }).expect(201);
    const row = await expectAuditedByAdmin('Broker', created.body.id, 'CREATE');
    // Restricted fields are left out of audit snapshots entirely (not even a placeholder).
    expect(row.after as Record<string, unknown>).not.toHaveProperty('panCiphertext');
    expect(row.after as Record<string, unknown>).not.toHaveProperty('panKeyVersion');
    expect(JSON.stringify(row.after)).not.toContain('ABCDE1234F');
    await send('post', `/brokers/${created.body.id}/deactivate`).expect(201);
    await expectAuditedByAdmin('Broker', created.body.id, 'UPDATE');

    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const ruleId = await makeFlatCommissionRule(systemPrisma, fx.companyId, brokerId, 2);
    await send('post', `/brokers/${brokerId}/commission-rules/${ruleId}/deactivate`).expect(201);
    await expectAuditedByAdmin('BrokerCommissionRule', ruleId, 'UPDATE');

    const booking = await bookingFor();
    await send('post', `/bookings/${booking.id}/broker`, { brokerId }).expect(201);
    await expectAuditedByAdmin('Booking', booking.id, 'UPDATE');
  });

  it('masters: GST rate update, TDS rule, letter template, SMS template', async () => {
    await send('patch', `/masters/gst-rates/${fx.defaultGstRateId}`, { description: 'renamed' }).expect(200);
    await expectAuditedByAdmin('GstRate', fx.defaultGstRateId, 'UPDATE');

    const tds = await send('post', '/masters/tds-rules', {
      section: `A${String(TAG).slice(-6)}`, ratePercent: 1, thresholdPaise: '5000000000', effectiveFrom: '2020-01-01',
    }).expect(201);
    await expectAuditedByAdmin('TdsRule', tds.body.id, 'CREATE');

    const letter = await send('post', '/masters/letter-templates', {
      name: 'Allotment', subject: 'Allotment', entityType: 'ALLOTMENT_LETTER', body: 'Hello',
    }).expect(201);
    await expectAuditedByAdmin('LetterTemplate', letter.body.id, 'CREATE');

    const sms = await send('post', '/masters/sms-templates', {
      name: 'Welcome', dltTemplateId: `D${TAG}`, senderId: 'OESTAT', body: 'Welcome',
    }).expect(201);
    await expectAuditedByAdmin('SmsTemplate', sms.body.id, 'CREATE');
  });

  it('follow-ups: update', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const inquiry = await systemPrisma.inquiry.create({ data: { companyId: fx.companyId, applicantId } });
    const followUp = await systemPrisma.followUp.create({
      data: { companyId: fx.companyId, inquiryId: inquiry.id, notes: 'first call', createdById: adminId },
    });
    await send('patch', `/inquiries/${inquiry.id}/follow-ups/${followUp.id}`, { notes: 'edited' }).expect(200);
    await expectAuditedByAdmin('FollowUp', followUp.id, 'UPDATE');
  });

  it('documents: receipt reprint', async () => {
    const booking = await bookingFor();
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: 10_00_000_00n }] },
      fx.userId,
    );
    const receipt = await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2026-06-16'),
        mode: 'NEFT',
        grossAmountPaise: 1_00_000_00n,
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: 1_00_000_00n }],
        tdsDeductedPaise: 0n,
      },
      fx.userId,
    );
    await send('post', `/receipts/${receipt.id}/pdf`).expect(201);
    await send('post', `/receipts/${receipt.id}/pdf/reprint`).expect(201);
    await expectAuditedByAdmin('Receipt', receipt.id, 'UPDATE');
  });

  it('construction updates: create', async () => {
    const created = await send('post', '/admin/construction-updates', {
      projectId: fx.projectId, title: 'Slab cast', publishedAt: '2026-06-01',
    }).expect(201);
    await expectAuditedByAdmin('ConstructionUpdate', created.body.id, 'CREATE');
  });

  it('NOCs: request', async () => {
    const brokerId = await makeBroker(systemPrisma, fx.companyId);
    const booking = await bookingFor(brokerId);
    const noc = await send('post', `/bookings/${booking.id}/noc/request`, { reason: 'transfer' }).expect(201);
    await expectAuditedByAdmin('BrokerNoc', noc.body.id, 'CREATE');
  });

  it('communications: the send is audited as the admin, the worker status update as the system (no actor)', async () => {
    const mobile = phone();
    const applicant = await systemPrisma.applicant.create({
      data: { companyId: fx.companyId, name: 'Mail Me', primaryPhone: mobile, primaryPhoneNormalized: mobile, email: `mail-${TAG}@test.com` },
    });
    const log = await send('post', `/applicants/${applicant.id}/communications`, { channel: 'EMAIL', subject: 'Hi', body: 'Hello' }).expect(201);
    await expectAuditedByAdmin('CommunicationLog', log.body.id, 'CREATE');

    // The BullMQ worker (a background job, no request) marks it sent.
    let update: { userId: string | null } | null = null;
    for (let i = 0; i < 50 && !update; i++) {
      update = await systemPrisma.auditLog.findFirst({
        where: { companyId: fx.companyId, entityType: 'CommunicationLog', entityId: log.body.id, action: 'UPDATE' },
      });
      if (!update) await new Promise((r) => setTimeout(r, 200));
    }
    expect(update, 'worker status update is audited').toBeTruthy();
    expect(update!.userId).toBeNull();
  });

  it('plugins: installing generic-sales audits the custom field it seeds, as the admin', async () => {
    await send('post', '/admin/plugins/generic-sales/install').expect(201);
    const def = await systemPrisma.customFieldDefinition.findFirst({
      where: { companyId: fx.companyId, key: 'warranty_period_months' },
    });
    await expectAuditedByAdmin('CustomFieldDefinition', def.id, 'CREATE');
  });
});
