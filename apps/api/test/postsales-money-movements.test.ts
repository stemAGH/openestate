/**
 * Transfer money-invariant, cancellation deduction math, two-phase refund
 * (approval / payment-failure / refund-cheque-bounce), and TDS receivable.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK, COMPANY_LEVY_ENTRY_TYPES, LEDGER_ENTRY_TYPE } from '@openestate/shared';
import { runWithTenant, withTenantTx } from '@openestate/db';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('Money movements: transfer / cancellation / refund / TDS', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;
  let cancelRuleId: string;
  let feeRuleId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
    const rule = await systemPrisma.cancellationRule.create({
      data: { companyId: fx.companyId, name: '10%', deductionType: 'PERCENT', deductionPercent: 10 },
    });
    cancelRuleId = rule.id;
    const fee = await systemPrisma.transferFeeRule.create({
      data: { companyId: fx.companyId, name: 'Fee 50k', feeType: 'FIXED', amountPaise: L(50_000) },
    });
    feeRuleId = fee.id;
    // 194-IA TDS rule (threshold ₹50,00,000).
    await systemPrisma.tdsRule.create({
      data: { companyId: fx.companyId, section: '194-IA', ratePercent: 1, thresholdPaise: L(50_00_000), effectiveFrom: new Date('2019-09-01') },
    });
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function bookedWithPlan(price: bigint) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: price , gstRateId: fx.defaultGstRateId }] },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: price }] },
      fx.userId,
    );
    return { booking, installment: plan.installments[0], applicantId };
  }

  it('transfer preserves total money (excluding the fee)', async () => {
    const { booking, installment } = await bookedWithPlan(L(30_00_000));
    // Pay ₹10,00,000 → balance ₹20,00,000.
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(10_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    const balBefore = await svc.ledger.balance(fx.companyId, booking.id);
    expect(balBefore).toBe(L(20_00_000));

    const newUnitId = await makeUnit(systemPrisma, fx);
    const { toBookingId } = await svc.transfers.transfer(
      fx.companyId,
      booking.id,
      { transferType: 'UNIT', toUnitId: newUnitId, transferFeeRuleId: feeRuleId },
      fx.userId,
    );

    const fromBal = await svc.ledger.balance(fx.companyId, booking.id);
    const toBalTotal = await svc.ledger.balance(fx.companyId, toBookingId);
    // Exclude the company levy (transfer fee) from the new booking's balance.
    const feeOnTo = await runWithTenant({ companyId: fx.companyId }, () =>
      withTenantTx(tenantPrisma, fx.companyId, (tx) =>
        svc.ledger.sumByTypesInTx(tx, fx.companyId, toBookingId, [...COMPANY_LEVY_ENTRY_TYPES]),
      ),
    );
    expect(fromBal).toBe(0n); // old booking closed
    expect(toBalTotal - feeOnTo).toBe(balBefore); // money conserved across the pair

    // Old unit released, new unit booked.
    const oldUnit = await systemPrisma.unit.findFirst({ where: { id: booking.unitId } });
    const newUnit = await systemPrisma.unit.findFirst({ where: { id: newUnitId } });
    expect(oldUnit.status).toBe('AVAILABLE');
    expect(newUnit.status).toBe('BOOKED');
  });

  it('cancellation: refundable = netReceived − deduction; balance = −refundable', async () => {
    const { booking, installment } = await bookedWithPlan(L(30_00_000));
    // Fully pay ₹30,00,000 (NEFT → counts as cleared cash).
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(30_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(30_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    const res = await svc.cancellations.cancel(fx.companyId, booking.id, { cancellationType: 'CANCEL', cancellationRuleId: cancelRuleId }, fx.userId);
    // deduction = 10% of ₹30,00,000 = ₹3,00,000; refundable = 30L − 3L = ₹27,00,000.
    expect(res.deductionPaise).toBe(L(3_00_000).toString());
    expect(res.refundablePaise).toBe(L(27_00_000).toString());
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(-L(27_00_000));
    expect(res.event.type).toBe('bookingCancelled');

    // Unit returned to available.
    const unit = await systemPrisma.unit.findFirst({ where: { id: booking.unitId } });
    expect(unit.status).toBe('AVAILABLE');
  });

  it('two-phase refund: approval posts a debit, payment records a voucher (no ledger change), cheque bounce reconciles', async () => {
    // v0.10.1: a refund cheque bounce is charged from its own setting (default 0); ₹500 here, as the test expects.
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { refundChequeBounceChargePaise: L(500) } });
    const { booking, installment } = await bookedWithPlan(L(30_00_000));
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(30_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(30_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.cancellations.cancel(fx.companyId, booking.id, { cancellationType: 'CANCEL', cancellationRuleId: cancelRuleId }, fx.userId);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(-L(27_00_000));

    const refund = await svc.refunds.request(fx.companyId, booking.id, { amountPaise: L(27_00_000), mode: 'CHEQUE' }, fx.userId);
    await svc.refunds.approve(fx.companyId, refund.id, fx.userId);
    // Approval discharges the obligation in the sub-ledger.
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(0n);

    const voucher = await svc.refunds.pay(fx.companyId, refund.id, { mode: 'CHEQUE', instrumentNumber: 'C-1' }, fx.userId);
    // Payment records an outflow but posts NO ledger entry.
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(0n);
    const paidRefund = await systemPrisma.refund.findFirst({ where: { id: refund.id } });
    expect(paidRefund.status).toBe('PAID');

    // The refund cheque bounces → obligation re-opens + bounce charge.
    await svc.refunds.voucherBounced(fx.companyId, voucher.id, fx.userId);
    // −27,00,000 (re-owed) + ₹500 bounce charge.
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(-L(27_00_000) + L(500));
    const reopened = await systemPrisma.refund.findFirst({ where: { id: refund.id } });
    // v0.10.1 (owner ruling 2026-11-17): back to REQUESTED, so paying again
    // needs a new approval (was APPROVED, which let the same money be refunded twice).
    expect(reopened.status).toBe('REQUESTED');
  });

  it('TDS receivable stays outstanding until the certificate is recorded, then zero', async () => {
    // Above threshold so TDS applies.
    const { booking, installment } = await bookedWithPlan(L(60_00_000));
    // Pay ₹10,00,000 with ₹10,000 TDS withheld (1%).
    const receipt = await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(10_00_000) }], tdsDeductedPaise: L(10_000) },
      fx.userId,
    );
    // Balance: 60L − 10L (credit) + 10k (TDS receivable) = 50,10,000.
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(60_00_000) - L(10_00_000) + L(10_000));

    const ded = await systemPrisma.tdsDeduction.findFirst({ where: { receiptId: receipt.id } });
    expect(ded.deductedPaise).toBe(L(10_000));

    // Record the certificate → TDS receivable zeroed.
    await svc.receipts.recordTdsCertificate(fx.companyId, ded.id, { certificateNumber: 'CERT-1', certificateDate: new Date('2026-07-10') }, fx.userId);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(60_00_000) - L(10_00_000));
  });

  it('sub-threshold booking posts no TDS receivable', async () => {
    const { booking, installment } = await bookedWithPlan(L(30_00_000)); // below ₹50L threshold
    await expect(
      svc.receipts.createReceipt(
        fx.companyId,
        { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(10_00_000) }], tdsDeductedPaise: L(10_000) },
        fx.userId,
      ),
    ).rejects.toThrow(/below the TDS threshold/i);

    // A receipt with no TDS on a sub-threshold booking posts no TDS_RECEIVABLE.
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(10_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    const tdsRows = await systemPrisma.ledgerEntry.count({ where: { companyId: fx.companyId, bookingId: booking.id, entryType: LEDGER_ENTRY_TYPE.TDS_RECEIVABLE } });
    expect(tdsRows).toBe(0);
  });
});
