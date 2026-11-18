/**
 * Removing a co-applicant takes the booking away from their portal account at
 * once, including a session that is already signed in (owner ruling
 * 2026-11-18). Portal access is decided per request by row-level security on
 * booking_co_applicants; the token carries only the customer's identity. This
 * test proves it through the real HTTP stack with one open session: the
 * booking, its account details and its statement are visible while they are a
 * co-applicant and gone on the very next request after removal, with no
 * new sign-in. The removal is audited (COAPP_REMOVED).
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import * as argon2 from '@node-rs/argon2';
import { ROLE_PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { makeClients, buildServices, makeUnit, makeApplicant } from './helpers/postsales-harness';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const PASSWORD = 'PortalPass123';

describeIf('a removed co-applicant loses portal access at once', () => {
  let t: TwoCompanies;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let bookingId: string;
  let bookingNumber: string;
  let statementId: string;
  let person: string;
  let phone: string;

  beforeAll(async () => {
    t = await setupTwoCompanies(`coportal${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    const svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    const b = await svc.bookings.createBooking(
      t.A.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.A.fx), primaryApplicantId: await makeApplicant(t.systemPrisma, t.A.fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: t.A.fx.defaultGstRateId }],
      },
      t.A.fx.userId,
    );
    bookingId = b.id;
    bookingNumber = b.bookingNumber;
    const statement = await t.send('post', `/bookings/${bookingId}/documents/statement`);
    expect(statement.status, JSON.stringify(statement.body)).toBe(201);
    statementId = statement.body.id;

    // The co-applicant-to-be, with a customer portal account.
    person = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    phone = (await t.systemPrisma.applicant.findUnique({ where: { id: person } })).primaryPhone;
    const keys = ROLE_PERMISSIONS.customer as readonly string[];
    const perms = await t.systemPrisma.permission.findMany({ where: { key: { in: [...keys] } } });
    const role = await t.systemPrisma.role.create({ data: { companyId: t.A.fx.companyId, name: 'customer', slug: 'customer', isSystem: true, isPortal: true } });
    await t.systemPrisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
    await t.systemPrisma.user.create({
      data: {
        companyId: t.A.fx.companyId, applicantId: person, phone, name: 'Co Buyer', roleId: role.id, forcePasswordChange: false,
        passwordHash: await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  it('sees the booking, its account and statement while a co-applicant, and none of them on the next request after removal', async () => {
    const added = await t.send('post', `/bookings/${bookingId}/co-applicants`, { applicantId: person, confirmPortalAccess: true });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    // One portal session, signed in once and kept open throughout.
    const login = await request(t.app.getHttpServer()).post('/api/v1/portal/auth/login').send({ identifier: phone, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const token = login.body.accessToken as string;
    const portal = (path: string) => request(t.app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

    const before = { property: await portal('/portal/property'), account: await portal('/portal/account'), doc: await portal(`/portal/account/documents/${statementId}/download`) };
    expect(before.property.status, JSON.stringify(before.property.body)).toBe(200);
    expect(JSON.stringify(before.property.body)).toContain(bookingNumber);
    expect(JSON.stringify(before.account.body)).toContain(bookingId);
    expect(before.doc.status).toBe(200);

    const removed = await t.send('delete', `/bookings/${bookingId}/co-applicants/${person}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    // Same token, no new sign-in.
    const after = { property: await portal('/portal/property'), account: await portal('/portal/account'), doc: await portal(`/portal/account/documents/${statementId}/download`) };
    expect(after.property.status).toBe(200);
    expect(JSON.stringify(after.property.body)).not.toContain(bookingNumber);
    expect(JSON.stringify(after.account.body)).not.toContain(bookingId);
    expect(after.doc.status).toBe(404);

    const audit = await t.systemPrisma.auditLog.findFirst({ where: { entityId: bookingId, action: 'COAPP_REMOVED' } });
    expect(audit?.after).toMatchObject({ applicantId: person });
  });
});
