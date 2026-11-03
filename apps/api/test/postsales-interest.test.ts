/**
 * Interest accrual against hand-computed fixtures with a fixed clock:
 * simple, compound, and the partial-payment (declining-balance) case.
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Clock } from '@openestate/shared';
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
// roundedDiv(base * bps * days, 365*10000)
function simpleInterest(principal: bigint, ratePercent: number, days: number): bigint {
  const bps = BigInt(Math.round(ratePercent * 100));
  const num = principal * bps * BigInt(days);
  const den = 365n * 10_000n;
  return (num + den / 2n) / den; // half-up
}

describeIf('Interest accrual (fixed clock, hand-computed fixtures)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let simpleRuleId: string;
  let compoundRuleId: string;

  const now = { value: new Date('2026-08-01T00:00:00.000Z') };
  const clock: Clock = { now: () => now.value };
  let svc: Services;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, clock);
    fx = await seedCompany(systemPrisma);
    const simple = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: '18% simple', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    const compound = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: '18% compound', rateType: 'COMPOUND', ratePercent: 18, frequency: 'YEARLY' },
    });
    simpleRuleId = simple.id;
    compoundRuleId = compound.id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function bookingWithOverdueInstallment(interestRuleId: string, dueDate: Date, amount: bigint) {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      { unitId, primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-01-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: amount , gstRateId: fx.defaultGstRateId }] },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId } });
    const plan = await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate, amountPaise: amount }] },
      fx.userId,
    );
    return { booking, installment: plan.installments[0] };
  }

  it('SIMPLE: interest = principal · rate · days / 365', async () => {
    // Due 2026-07-02, asOf 2026-08-01 → 30 days overdue; principal ₹10,00,000.
    const { booking } = await bookingWithOverdueInstallment(simpleRuleId, new Date('2026-07-02'), L(10_00_000));
    const res = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    const expected = simpleInterest(L(10_00_000), 18, 30);
    expect(res.postedPaise).toBe(expected);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(L(10_00_000) + expected);
  });

  it('is idempotent: re-running at the same asOf posts nothing further', async () => {
    const { booking } = await bookingWithOverdueInstallment(simpleRuleId, new Date('2026-07-02'), L(5_00_000));
    await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    const balAfterFirst = await svc.ledger.balance(fx.companyId, booking.id);
    const again = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    expect(again.postedPaise).toBe(0n);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(balAfterFirst);
  });

  it('COMPOUND: second window accrues on principal + prior accrued interest', async () => {
    const { booking } = await bookingWithOverdueInstallment(compoundRuleId, new Date('2026-07-02'), L(10_00_000));
    // First window: due 2026-07-02 → 2026-08-01 = 30 days on ₹10,00,000.
    const r1 = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    const i1 = simpleInterest(L(10_00_000), 18, 30);
    expect(r1.postedPaise).toBe(i1);
    // Second window: 2026-08-01 → 2026-08-31 = 30 days on (principal + i1).
    const r2 = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-31'));
    const i2 = simpleInterest(L(10_00_000) + i1, 18, 30);
    expect(r2.postedPaise).toBe(i2);
  });

  it('partial payment lowers the principal for future windows (declining balance)', async () => {
    const { booking, installment } = await bookingWithOverdueInstallment(simpleRuleId, new Date('2026-07-02'), L(10_00_000));
    // Accrue first 30 days on full ₹10,00,000.
    const r1 = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    expect(r1.postedPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
    // Pay ₹6,00,000 → outstanding ₹4,00,000.
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: booking.id, receiptDate: new Date('2026-08-01'), mode: 'NEFT', grossAmountPaise: L(6_00_000), allocations: [{ installmentId: installment.id, amountPaise: L(6_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    // Next 30 days accrue on the reduced ₹4,00,000.
    const r2 = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-31'));
    expect(r2.postedPaise).toBe(simpleInterest(L(4_00_000), 18, 30));
  });

  it('posts nothing on a cancelled booking, even through the manual accrue path', async () => {
    const { booking } = await bookingWithOverdueInstallment(simpleRuleId, new Date('2026-07-02'), L(10_00_000));
    await svc.cancellations.cancel(fx.companyId, booking.id, { cancellationType: 'CANCEL' }, fx.userId);
    const balanceAfterCancel = await svc.ledger.balance(fx.companyId, booking.id);
    const res = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    expect(res.postedPaise).toBe(0n);
    expect(await systemPrisma.interestAccrual.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(balanceAfterCancel);
  });

  it('waiver posts an audited credit that reduces the balance', async () => {
    const { booking } = await bookingWithOverdueInstallment(simpleRuleId, new Date('2026-07-02'), L(10_00_000));
    await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    const before = await svc.ledger.balance(fx.companyId, booking.id);
    await svc.interest.waiveInterest(fx.companyId, booking.id, { amountPaise: L(1000), reason: 'goodwill' }, fx.userId);
    expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(before - L(1000));
  });
});
