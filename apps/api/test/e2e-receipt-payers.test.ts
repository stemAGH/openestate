/**
 * Receipt Entry's payer lookup (GET /receipts/payers): a receipt clerk finds
 * the person paying by name, phone or booking number without any pre-sales
 * permission. Only people on an active booking are returned, with a masked
 * phone and their active bookings; leads and other companies never are.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';
import { makeClients, buildServices, makeUnit, makeApplicant } from './helpers/postsales-harness';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

type Payer = { id: string; name: string; phoneMasked: string; bookings: Array<{ id: string; bookingNumber: string; unitLabel: string }> };

describeIf('GET /receipts/payers', () => {
  let t: TwoCompanies;
  let clerk: Send;
  let noReceipt: Send;
  let primary: { id: string; phone: string; bookingNumber: string };
  let coApplicant: string;
  let cancelledOnly: string;
  let otherCompanyPhone: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;

  beforeAll(async () => {
    t = await setupTwoCompanies(`payers${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    const svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    const book = async (fx: TwoCompanies['A']['fx'], primaryApplicantId: string, coApplicantIds: string[] = []) =>
      svc.bookings.createBooking(
        fx.companyId,
        {
          unitId: await makeUnit(t.systemPrisma, fx), primaryApplicantId, coApplicantIds, bookingDate: new Date('2026-06-01'),
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: fx.defaultGstRateId }],
        },
        fx.userId,
      );

    const a = await t.systemPrisma.applicant.findUniqueOrThrow({ where: { id: t.A.applicant } });
    const own = await t.systemPrisma.booking.findUniqueOrThrow({ where: { id: t.own.booking } });
    primary = { id: a.id, phone: a.primaryPhone, bookingNumber: own.bookingNumber };

    // A co-applicant on another active booking of company A.
    coApplicant = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    await book(t.A.fx, await makeApplicant(t.systemPrisma, t.A.fx.companyId), [coApplicant]);

    // Someone whose only booking was cancelled.
    cancelledOnly = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    const cancelled = await book(t.A.fx, cancelledOnly);
    await t.systemPrisma.booking.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });

    // Company B's booked applicant.
    await book(t.B.fx, t.B.applicant);
    otherCompanyPhone = (await t.systemPrisma.applicant.findUniqueOrThrow({ where: { id: t.B.applicant } })).primaryPhone;

    // The accounts role's receipt permissions, and nothing from pre-sales.
    ({ send: clerk } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.POSTSALES_RECEIPT_CREATE, PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.POSTSALES_PLAN_READ], `clerk-${t.tag}`));
    // Everything a sales manager reads, but not receipt.create.
    ({ send: noReceipt } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_APPLICANT_READ, PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.POSTSALES_RECEIPT_READ], `norcpt-${t.tag}`));
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  const find = async (search: string): Promise<Payer[]> => {
    const res = await clerk('get', `/receipts/payers?search=${encodeURIComponent(search)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
  };

  it('finds a booked applicant by phone in any format, with a masked phone and the active booking', async () => {
    const spaced = `+91 ${primary.phone.slice(0, 5)} ${primary.phone.slice(5)}`;
    for (const q of [primary.phone, spaced, primary.phone.slice(-6)]) {
      const rows = await find(q);
      const row = rows.find((r) => r.id === primary.id);
      expect(row, q).toBeDefined();
      expect(row!.bookings.map((b) => b.bookingNumber)).toEqual([primary.bookingNumber]);
      expect(row!.phoneMasked).not.toContain(primary.phone.slice(2, 8));
      expect(row!.phoneMasked.slice(-4)).toBe(primary.phone.slice(-4));
    }
  });

  it('never returns a full phone number anywhere in the response', async () => {
    const res = await clerk('get', `/receipts/payers?search=${primary.phone}`);
    expect(JSON.stringify(res.body)).not.toContain(primary.phone);
  });

  it('finds the payer by booking number', async () => {
    const rows = await find(primary.bookingNumber);
    expect(rows.map((r) => r.id)).toContain(primary.id);
  });

  it('finds a co-applicant of an active booking', async () => {
    const phone = (await t.systemPrisma.applicant.findUniqueOrThrow({ where: { id: coApplicant } })).primaryPhone;
    const rows = await find(phone);
    expect(rows.map((r) => r.id)).toContain(coApplicant);
    expect(rows.find((r) => r.id === coApplicant)!.bookings).toHaveLength(1);
  });

  it('does not return a lead with no booking, or someone whose only booking is cancelled', async () => {
    expect((await find('9811177701')).length).toBe(0); // the inquiry's lead-only applicant
    const phone = (await t.systemPrisma.applicant.findUniqueOrThrow({ where: { id: cancelledOnly } })).primaryPhone;
    expect((await find(phone)).map((r) => r.id)).not.toContain(cancelledOnly);
  });

  it("never returns another company's booked applicant", async () => {
    expect((await find(otherCompanyPhone)).length).toBe(0);
  });

  it('is refused without the receipt-create permission (control: the same user reads applicants)', async () => {
    const control = await noReceipt('get', `/applicants?search=${primary.phone}`);
    expect(control.status).toBe(200);
    const res = await noReceipt('get', `/receipts/payers?search=${primary.phone}`);
    expect(res.status).toBe(403);
  });

  it('rejects unknown query parameters and a too-short search', async () => {
    expect((await clerk('get', '/receipts/payers?search=98&x=1')).status).toBe(400);
    expect((await clerk('get', '/receipts/payers?search=9')).status).toBe(400);
  });
});
