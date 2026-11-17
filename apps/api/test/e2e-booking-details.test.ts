/**
 * Non-financial booking edits (v0.10.1, Plan D), under postsales.booking.update
 * and the bookings-list scope, refused (409) on a cancelled, surrendered or
 * transferred-out booking:
 * - a remark (new nullable column);
 * - co-applicants: add (only with confirmPortalAccess: the person's portal
 *   account can then see the booking), remove, reorder; company ownership
 *   checked; the primary applicant is never a co-applicant;
 * - the broker: refused once commission has accrued on the booking.
 * Every change is audited.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { runWithTenant } from '@openestate/db';
import { PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';
import { makeClients, buildServices, makeUnit, makeApplicant, makeFlatCommissionRule } from './helpers/postsales-harness';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('non-financial booking edits', () => {
  let t: TwoCompanies;
  let outsider: Send;
  let readOnly: Send;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;

  async function booking() {
    const b = await svc.bookings.createBooking(
      t.A.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.A.fx), primaryApplicantId: await makeApplicant(t.systemPrisma, t.A.fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: t.A.fx.defaultGstRateId }],
      },
      t.A.fx.userId,
    );
    return b as { id: string; primaryApplicantId: string };
  }
  const coApps = async (bookingId: string) =>
    (await t.systemPrisma.bookingCoApplicant.findMany({ where: { bookingId }, orderBy: { ordinal: 'asc' } })).map((r: { applicantId: string; ordinal: number }) => [r.applicantId, r.ordinal]);

  beforeAll(async () => {
    t = await setupTwoCompanies(`bkdet${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    ({ send: outsider } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.POSTSALES_BOOKING_UPDATE], `out-${t.tag}`));
    ({ send: readOnly } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.ADMIN_TEAM_SCOPE_ALL], `ro-${t.tag}`));
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  it('sets and clears a remark; length and unknown fields are checked; the audit row has before and after', async () => {
    const b = await booking();
    expect((await t.send('patch', `/bookings/${b.id}`, { remark: 'Wants the corner unit keys early' })).status).toBe(200);
    expect((await t.systemPrisma.booking.findUnique({ where: { id: b.id } })).remark).toBe('Wants the corner unit keys early');
    expect((await t.send('patch', `/bookings/${b.id}`, { remark: null })).status).toBe(200);
    expect((await t.systemPrisma.booking.findUnique({ where: { id: b.id } })).remark).toBeNull();
    expect((await t.send('patch', `/bookings/${b.id}`, { remark: 'x'.repeat(1001) })).status).toBe(400);
    expect((await t.send('patch', `/bookings/${b.id}`, { agreedPricePaise: '1' })).status).toBe(400);
    const audit = await t.systemPrisma.auditLog.findFirst({ where: { entityId: b.id, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.before).toEqual({ remark: 'Wants the corner unit keys early' });
  });

  it('adds a co-applicant only with the portal-access confirmation; their portal account then sees the booking; removal takes it away', async () => {
    const b = await booking();
    const person = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    expect((await t.send('post', `/bookings/${b.id}/co-applicants`, { applicantId: person })).status).toBe(400);
    const added = await t.send('post', `/bookings/${b.id}/co-applicants`, { applicantId: person, confirmPortalAccess: true });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(await coApps(b.id)).toEqual([[person, 2]]);
    const audit = await t.systemPrisma.auditLog.findFirst({ where: { entityId: b.id, action: 'COAPP_ADDED' } });
    expect(audit?.after).toMatchObject({ applicantId: person, primaryApplicantId: b.primaryApplicantId });

    const { PortalPropertyService } = createRequire(import.meta.url)('../dist/customer-portal/portal-property.service');
    const portal = t.app.get(PortalPropertyService);
    const sees = async () =>
      (await runWithTenant({ companyId: t.A.fx.companyId, portalApplicantId: person }, () => portal.getMyProperties(t.A.fx.companyId, person))).length;
    expect(await sees()).toBe(1);

    expect((await t.send('delete', `/bookings/${b.id}/co-applicants/${person}`)).status).toBe(200);
    expect(await coApps(b.id)).toEqual([]);
    expect(await sees()).toBe(0);
    expect(await t.systemPrisma.auditLog.count({ where: { entityId: b.id, action: 'COAPP_REMOVED' } })).toBe(1);
  });

  it('refuses the primary applicant, a duplicate, and another company\'s applicant; reorders co-applicants', async () => {
    const b = await booking();
    const p1 = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    const p2 = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    const add = (applicantId: string) => t.send('post', `/bookings/${b.id}/co-applicants`, { applicantId, confirmPortalAccess: true });
    expect((await add(b.primaryApplicantId)).status).toBe(409);
    expect((await add(p1)).status).toBe(201);
    expect((await add(p1)).status).toBe(409);
    expect((await add(t.B.applicant)).status).toBe(404);
    expect((await add(p2)).status).toBe(201);
    expect(await coApps(b.id)).toEqual([[p1, 2], [p2, 3]]);
    expect((await t.send('put', `/bookings/${b.id}/co-applicants/order`, { applicantIds: [p2, p1] })).status).toBe(200);
    expect(await coApps(b.id)).toEqual([[p2, 2], [p1, 3]]);
    expect((await t.send('put', `/bookings/${b.id}/co-applicants/order`, { applicantIds: [p2] })).status).toBe(400);
    expect((await t.send('delete', `/bookings/${b.id}/co-applicants/${b.primaryApplicantId}`)).status).toBe(404);
  });

  it('is refused on a cancelled booking (409), outside the caller\'s scope (404) and without the permission (403)', async () => {
    const b = await booking();
    await t.systemPrisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
    expect((await t.send('patch', `/bookings/${b.id}`, { remark: 'late' })).status).toBe(409);
    expect((await t.send('post', `/bookings/${b.id}/co-applicants`, { applicantId: await makeApplicant(t.systemPrisma, t.A.fx.companyId), confirmPortalAccess: true })).status).toBe(409);
    const live = await booking();
    expect((await outsider('patch', `/bookings/${live.id}`, { remark: 'x' })).status).toBe(404);
    expect((await readOnly('patch', `/bookings/${live.id}`, { remark: 'x' })).status).toBe(403);
  });

  it('a broker change is allowed before commission accrues and refused (409) after', async () => {
    const b = await booking();
    expect((await t.send('post', `/bookings/${b.id}/broker`, { brokerId: t.A.broker })).status).toBeLessThan(300);
    // Commission accrued on this booking (as CommissionService.accrueForBooking records it).
    const ruleId = await makeFlatCommissionRule(t.systemPrisma, t.A.fx.companyId, t.A.broker, 1);
    await t.systemPrisma.brokerBookingCommission.create({
      data: { companyId: t.A.fx.companyId, bookingId: b.id, brokerId: t.A.broker, ruleId, totalCommissionPaise: 1000n },
    });
    const other = await t.systemPrisma.broker.create({ data: { companyId: t.A.fx.companyId, name: `Other broker ${t.tag}`, phone: '9800000999' } });
    const res = await t.send('post', `/bookings/${b.id}/broker`, { brokerId: other.id });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(String(res.body.message)).toMatch(/commission/i);
    expect((await t.systemPrisma.booking.findUnique({ where: { id: b.id } })).brokerId).toBe(t.A.broker);
  });
});
