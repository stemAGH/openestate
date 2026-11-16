/**
 * QA-015: a refund was capped only when requested, against the ledger, and a
 * REQUESTED refund posts nothing, so two requests for the full amount both
 * passed and both could be approved and paid. The cap now holds at request
 * (net of other open requests), at approval and at payment, under a per-
 * booking lock; and an upgrade report lists bookings already over-refunded.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { makeClients, buildServices, seedCompany, makeUnit, makeApplicant, cleanupCompany, type Services, type CompanyFixture } from './helpers/postsales-harness';
import { holdAdvisoryLock, countBlockedBehind } from './helpers/row-lock-barrier';
import * as sync from '../../../packages/db/prisma/sync-permissions';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const L = (rupees: number) => BigInt(rupees) * 100n;
// Through the module object, so this file loads before the report exists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const overRefundedBookings = (sync as any).overRefundedBookings as
  | ((c: unknown, s: { companyId: string }) => Promise<Array<{ count: number; bookings: Array<{ bookingNumber: string; overPaise: string }> }>>)
  | undefined;

describeIf('refund cap (QA-015)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;
  let ruleId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
    ruleId = (await systemPrisma.cancellationRule.create({
      data: { companyId: fx.companyId, name: '10%', deductionType: 'PERCENT', deductionPercent: 10 },
    })).id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  /** A booking paid ₹10,00,000 and cancelled with 10% deducted: ₹9,00,000 refundable. */
  async function cancelledWithRefundable() {
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId: await makeUnit(systemPrisma, fx), primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId, booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'All', dueDate: new Date('2026-06-15'), amountPaise: booking.agreedPricePaise }] },
      fx.userId,
    );
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000),
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(10_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.cancellations.cancel(fx.companyId, booking.id, { cancellationType: 'CANCEL', cancellationRuleId: ruleId }, fx.userId);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(-L(9_00_000));
    return booking;
  }

  /** A debit posted after the fact (as a bounce charge would), so less is owed. */
  async function debit(bookingId: string, paise: bigint) {
    await systemPrisma.ledgerEntry.create({
      data: { companyId: fx.companyId, bookingId, entryType: 'BOUNCE_CHARGE', signedAmountPaise: paise, reason: 'test debit', effectiveDate: new Date('2026-07-01') },
    });
  }

  /** A REQUESTED refund as a release before the cap could leave it. */
  async function legacyRequest(bookingId: string, amountPaise: bigint) {
    return systemPrisma.refund.create({ data: { companyId: fx.companyId, bookingId, amountPaise, status: 'REQUESTED', createdById: fx.userId } });
  }

  const req = (bookingId: string, amountPaise: bigint) => svc.refunds.request(fx.companyId, bookingId, { amountPaise, mode: 'NEFT' }, fx.userId);

  it('a second request for the same money is refused; a split within the amount is allowed', async () => {
    const b = await cancelledWithRefundable();
    await req(b.id, L(9_00_000));
    await expect(req(b.id, L(9_00_000))).rejects.toThrow(/exceeds/);
    await expect(req(b.id, 1n)).rejects.toThrow(/exceeds/);

    const b2 = await cancelledWithRefundable();
    await req(b2.id, L(4_00_000));
    await req(b2.id, L(5_00_000));
    await expect(req(b2.id, 1n)).rejects.toThrow(/exceeds/);
  });

  it('after an approval, the approved amount counts too: no new request for it', async () => {
    const b = await cancelledWithRefundable();
    const r = await req(b.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, r.id, fx.userId);
    await expect(req(b.id, L(9_00_000))).rejects.toThrow(/exceeds/);
    // A rejected request frees its amount: none here, so still nothing left.
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(0n);
  });

  it('approval re-checks: two requests left open by an older release cannot both be approved', async () => {
    const b = await cancelledWithRefundable();
    const r1 = await legacyRequest(b.id, L(9_00_000));
    const r2 = await legacyRequest(b.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, r1.id, fx.userId);
    await expect(svc.refunds.approve(fx.companyId, r2.id, fx.userId)).rejects.toThrow(/exceeds/);
    expect((await systemPrisma.refund.findUnique({ where: { id: r2.id } })).status).toBe('REQUESTED');
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(0n);
  });

  it('approval re-checks against the ledger as it is now (less owed since the request)', async () => {
    const b = await cancelledWithRefundable();
    const r = await req(b.id, L(9_00_000));
    await debit(b.id, L(1_00_000));
    await expect(svc.refunds.approve(fx.companyId, r.id, fx.userId)).rejects.toThrow(/exceeds/);
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(-L(8_00_000));
  });

  it('payment re-checks: an approved refund is not paid once the ledger no longer covers it', async () => {
    const b = await cancelledWithRefundable();
    const r = await req(b.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, r.id, fx.userId);
    await debit(b.id, L(1_00_000));
    await expect(svc.refunds.pay(fx.companyId, r.id, { mode: 'NEFT' }, fx.userId)).rejects.toThrow(/exceeds/);
    expect(await systemPrisma.paymentVoucher.count({ where: { refundId: r.id } })).toBe(0);
    expect((await systemPrisma.refund.findUnique({ where: { id: r.id } })).status).toBe('APPROVED');
  });

  it('the normal flow is unchanged: request, approve and pay the full amount', async () => {
    const b = await cancelledWithRefundable();
    const r = await req(b.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, r.id, fx.userId);
    const v = await svc.refunds.pay(fx.companyId, r.id, { mode: 'NEFT' }, fx.userId);
    expect(v.amountPaise).toBe(L(9_00_000));
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(0n);
  });

  it('forced interleaving: two requests for the same money wait on the booking lock, and only one succeeds', async () => {
    const b = await cancelledWithRefundable();
    const barrier = await holdAdvisoryLock(systemPrisma, `refund:${b.id}`);
    const p1 = req(b.id, L(9_00_000));
    const p2 = req(b.id, L(9_00_000));
    const blocked = await countBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.allSettled([p1, p2]);
    expect(blocked).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await systemPrisma.refund.count({ where: { bookingId: b.id } })).toBe(1);
  }, 30_000);

  it('forced interleaving: two approvals of open requests for the same money, only one posts', async () => {
    const b = await cancelledWithRefundable();
    const r1 = await legacyRequest(b.id, L(9_00_000));
    const r2 = await legacyRequest(b.id, L(9_00_000));
    const barrier = await holdAdvisoryLock(systemPrisma, `refund:${b.id}`);
    const p1 = svc.refunds.approve(fx.companyId, r1.id, fx.userId);
    const p2 = svc.refunds.approve(fx.companyId, r2.id, fx.userId);
    const blocked = await countBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.allSettled([p1, p2]);
    expect(blocked).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(0n);
  }, 30_000);

  it('upgrade report: lists a booking whose approved refunds exceed what was refundable, and only that one', async () => {
    const over = await cancelledWithRefundable();
    // What an older release allowed: a second refund approved for the same money.
    const r1 = await req(over.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, r1.id, fx.userId);
    const r2 = await legacyRequest(over.id, L(9_00_000));
    await systemPrisma.refund.update({ where: { id: r2.id }, data: { status: 'APPROVED' } });
    await systemPrisma.ledgerEntry.create({
      data: { companyId: fx.companyId, bookingId: over.id, entryType: 'REFUND_APPROVED', signedAmountPaise: L(9_00_000), reason: 'Refund approved', effectiveDate: new Date('2026-07-01') },
    });

    // Refunded correctly, then its refund cheque bounced and was re-opened: not over.
    const fine = await cancelledWithRefundable();
    const rf = await req(fine.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, rf.id, fx.userId);
    const voucher = await svc.refunds.pay(fx.companyId, rf.id, { mode: 'CHEQUE', instrumentNumber: 'C-9' }, fx.userId);
    await svc.refunds.voucherBounced(fx.companyId, voucher.id, fx.userId);
    // ...and the customer now owes money for something else: still not over-refunded (nothing refunded net).
    await debit(fine.id, L(10_00_000));
    // Refunded in full and paid, normally: not over.
    const paid = await cancelledWithRefundable();
    const rp = await req(paid.id, L(9_00_000));
    await svc.refunds.approve(fx.companyId, rp.id, fx.userId);
    await svc.refunds.pay(fx.companyId, rp.id, { mode: 'NEFT' }, fx.userId);

    expect(typeof overRefundedBookings).toBe('function');
    const rows = await overRefundedBookings!(systemPrisma, { companyId: fx.companyId });
    expect(rows).toHaveLength(1);
    const listed = rows[0].bookings;
    expect(rows[0].count).toBe(listed.length);
    expect(listed).toContainEqual({ bookingNumber: over.bookingNumber, overPaise: String(L(9_00_000)) });
    expect(listed.map((x) => x.bookingNumber)).not.toContain(fine.bookingNumber);
    expect(listed.map((x) => x.bookingNumber)).not.toContain(paid.bookingNumber);
    // Every listed booking really has approved refunds above what it held.
    for (const x of listed) expect(BigInt(x.overPaise)).toBeGreaterThan(0n);
  });
});
