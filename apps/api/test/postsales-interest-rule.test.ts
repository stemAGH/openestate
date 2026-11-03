/**
 * Attaching, changing and removing a booking's delay-interest rule
 * (BookingInterestRuleService), against hand-computed figures with a fixed
 * clock. The HTTP half (route, permissions, audit row, master guard, RESTRICT)
 * is e2e-booking-interest-rule.test.ts.
 *
 * Rulings (v0.9 item 1): a rule may be attached at booking or afterwards;
 * interest runs only from the attach date (bookings.interest_from_date);
 * changing or removing a rule first settles interest up to today under the old
 * rule, and past interest is never recalculated; only SIMPLE rules may be
 * attached in v0.9; a transfer copies the rule with the floor set to the
 * transfer date.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
import { BookingInterestRuleService } from '../src/postsales/booking-interest-rule.service';

const describeIf =
  process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;
function simpleInterest(principal: bigint, ratePercent: number, days: number): bigint {
  const num = principal * BigInt(Math.round(ratePercent * 100)) * BigInt(days);
  const den = 365n * 10_000n;
  return (num + den / 2n) / den;
}
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

describeIf('BookingInterestRuleService (fixed clock)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let svc: Services;
  let rules: BookingInterestRuleService;
  let r18: string;
  let r24: string;
  let compound: string;
  let inactive: string;
  const now = { value: day('2026-08-01') };
  const clock: Clock = { now: () => now.value };

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, clock);
    rules = new BookingInterestRuleService(tenantPrisma, clock, svc.interest);
    fx = await seedCompany(systemPrisma);
    const mk = (name: string, rateType: string, ratePercent: number, isActive = true) =>
      systemPrisma.interestRule.create({
        data: { companyId: fx.companyId, name, rateType, ratePercent, frequency: 'YEARLY', isActive },
      });
    r18 = (await mk('18% simple', 'SIMPLE', 18)).id;
    r24 = (await mk('24% simple', 'SIMPLE', 24)).id;
    compound = (await mk('18% compound', 'COMPOUND', 18)).id;
    inactive = (await mk('old 12%', 'SIMPLE', 12, false)).id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  /** A booking (no rule) with one ₹10,00,000 installment due 2026-07-02. */
  async function booking() {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const b = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: day('2026-01-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await svc.plans.createCustomPlan(
      fx.companyId,
      b.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: day('2026-07-02'), amountPaise: L(10_00_000) }] },
      fx.userId,
    );
    return b.id as string;
  }

  const accrue = (id: string, asOf: string) => svc.interest.accrueForBooking(fx.companyId, id, day(asOf));

  it('attaching a rule late charges interest only from the attach date', async () => {
    const id = await booking();
    now.value = day('2026-08-01'); // 30 days after the due date
    const res = await rules.setRule(fx.companyId, id, r18, fx.userId);
    expect(res.interestRuleId).toBe(r18);
    expect(res.interestFromDate).toBe('2026-08-01');
    expect(res.settledPaise).toBe('0');

    const row = await systemPrisma.booking.findUnique({ where: { id } });
    expect(row.interestRuleId).toBe(r18);
    expect(isoDate(row.interestFromDate)).toBe('2026-08-01');

    // 2026-08-01 → 2026-08-31 = 30 days, not the 60 days since the due date.
    const r = await accrue(id, '2026-08-31');
    expect(r.postedPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
    const accrual = await systemPrisma.interestAccrual.findFirst({ where: { bookingId: id } });
    expect(isoDate(accrual.periodStart)).toBe('2026-08-01');
  });

  it('an installment that falls due after the attach date accrues from its due date', async () => {
    const id = await booking();
    now.value = day('2026-06-01');
    await rules.setRule(fx.companyId, id, r18, fx.userId);
    const r = await accrue(id, '2026-08-01'); // due 2026-07-02 → 30 days
    expect(r.postedPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
  });

  it('changing the rule settles up to today under the old rule, then the new rule applies; past interest stays as charged', async () => {
    const id = await booking();
    now.value = day('2026-06-01');
    await rules.setRule(fx.companyId, id, r18, fx.userId);

    now.value = day('2026-08-01');
    const res = await rules.setRule(fx.companyId, id, r24, fx.userId);
    const settled = simpleInterest(L(10_00_000), 18, 30); // 2026-07-02 → 2026-08-01 at 18%
    expect(res.settledPaise).toBe(settled.toString());
    expect(res.interestFromDate).toBe('2026-08-01');

    const r = await accrue(id, '2026-08-31'); // 30 days at 24%
    expect(r.postedPaise).toBe(simpleInterest(L(10_00_000), 24, 30));

    const rows = await systemPrisma.interestAccrual.findMany({ where: { bookingId: id }, orderBy: { periodEnd: 'asc' } });
    expect(rows.map((a: { interestRuleId: string }) => a.interestRuleId)).toEqual([r18, r24]);
    expect(rows[0].accruedPaise).toBe(settled);
    expect(Number(rows[0].ratePercentSnapshot)).toBe(18);
  });

  it('removing the rule settles up to today and stops further interest', async () => {
    const id = await booking();
    now.value = day('2026-06-01');
    await rules.setRule(fx.companyId, id, r18, fx.userId);

    now.value = day('2026-08-01');
    const res = await rules.setRule(fx.companyId, id, null, fx.userId);
    expect(res.settledPaise).toBe(simpleInterest(L(10_00_000), 18, 30).toString());
    expect(res.interestRuleId).toBeNull();
    expect(res.interestFromDate).toBeNull();

    expect((await accrue(id, '2026-12-31')).postedPaise).toBe(0n);
  });

  it('re-attaching after a removal does not charge the gap', async () => {
    const id = await booking();
    now.value = day('2026-06-01');
    await rules.setRule(fx.companyId, id, r18, fx.userId);
    now.value = day('2026-08-01');
    await rules.setRule(fx.companyId, id, null, fx.userId); // settled to 2026-08-01

    now.value = day('2026-09-30');
    await rules.setRule(fx.companyId, id, r18, fx.userId);
    const r = await accrue(id, '2026-10-30'); // 30 days from 2026-09-30, not 90 from 2026-08-01
    expect(r.postedPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
  });

  it('setting the rule it already has changes nothing', async () => {
    const id = await booking();
    now.value = day('2026-06-01');
    await rules.setRule(fx.companyId, id, r18, fx.userId);
    now.value = day('2026-08-01');
    const res = await rules.setRule(fx.companyId, id, r18, fx.userId);
    expect(res.settledPaise).toBe('0');
    expect(res.interestFromDate).toBe('2026-06-01');
    expect(await systemPrisma.interestAccrual.count({ where: { bookingId: id } })).toBe(0);
  });

  it('refuses a COMPOUND rule (409): compounding frequency is not applied yet', async () => {
    const id = await booking();
    await expect(rules.setRule(fx.companyId, id, compound, fx.userId)).rejects.toThrow(ConflictException);
    await expect(rules.setRule(fx.companyId, id, compound, fx.userId)).rejects.toThrow(/simple/i);
    const row = await systemPrisma.booking.findUnique({ where: { id } });
    expect(row.interestRuleId).toBeNull();
  });

  it('refuses an inactive rule (409) and a rule from another company (404)', async () => {
    const id = await booking();
    await expect(rules.setRule(fx.companyId, id, inactive, fx.userId)).rejects.toThrow(ConflictException);

    const other = await seedCompany(systemPrisma);
    try {
      const foreign = await systemPrisma.interestRule.create({
        data: { companyId: other.companyId, name: 'foreign', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
      });
      await expect(rules.setRule(fx.companyId, id, foreign.id, fx.userId)).rejects.toThrow(NotFoundException);
    } finally {
      await cleanupCompany(systemPrisma, other.companyId);
    }
  });

  it('refuses a booking that is no longer active (409)', async () => {
    const id = await booking();
    await svc.cancellations.cancel(fx.companyId, id, { cancellationType: 'CANCEL' }, fx.userId);
    await expect(rules.setRule(fx.companyId, id, r18, fx.userId)).rejects.toThrow(ConflictException);
  });

  it('a transfer copies the rule, with interest running from the transfer date', async () => {
    const id = await booking();
    now.value = day('2026-06-01');
    await rules.setRule(fx.companyId, id, r18, fx.userId);
    const newUnitId = await makeUnit(systemPrisma, fx);
    const { toBookingId } = await svc.transfers.transfer(
      fx.companyId,
      id,
      { transferType: 'UNIT', toUnitId: newUnitId },
      fx.userId,
    );
    const to = await systemPrisma.booking.findUnique({ where: { id: toBookingId } });
    expect(to.interestRuleId).toBe(r18);
    // TransferService dates the new booking with the real clock.
    expect(isoDate(to.interestFromDate)).toBe(isoDate(to.bookingDate));
  });
});
