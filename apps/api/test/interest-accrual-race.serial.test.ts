/**
 * Interest accrual under concurrency. Two accrual runs for one booking (the
 * daily job and the manual "accrue" action, or two clicks) used to both read
 * "no prior accrual" and both post the same period. The per-booking advisory
 * lock in InterestService.accrueInTx serialises them.
 *
 * The interleaving is forced, not hoped for: behindTableLock holds a table
 * lock and starts each request only once the earlier ones are waiting, so the
 * order is fixed. Without the advisory lock both accrual runs reach their
 * read of prior accruals before either has written.
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
import { behindTableLock } from './helpers/table-lock-barrier';
import { BookingInterestRuleService } from '../src/postsales/booking-interest-rule.service';
import { createMasterService } from '../src/masters/master.factory';
import { INTEREST_RULE_MASTER } from '../src/masters/interest-rule.master';

const describeIf =
  process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

const L = (rupees: number) => BigInt(rupees) * 100n;
function simpleInterest(principal: bigint, ratePercent: number, days: number): bigint {
  const num = principal * BigInt(Math.round(ratePercent * 100)) * BigInt(days);
  const den = 365n * 10_000n;
  return (num + den / 2n) / den;
}

describeIf('interest accrual under concurrency (serial)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let svc: Services;
  let ruleId: string;
  let rule24Id: string;
  let rules: BookingInterestRuleService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let masters: any;
  const clock: Clock = { now: () => new Date('2026-08-01T00:00:00.000Z') };

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, clock);
    fx = await seedCompany(systemPrisma);
    const rule = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: '18% simple', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    ruleId = rule.id;
    rule24Id = (
      await systemPrisma.interestRule.create({
        data: { companyId: fx.companyId, name: '24% simple', rateType: 'SIMPLE', ratePercent: 24, frequency: 'YEARLY' },
      })
    ).id;
    rules = new BookingInterestRuleService(tenantPrisma, clock, svc.interest);
    masters = new (createMasterService(INTEREST_RULE_MASTER))(tenantPrisma, systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function overdueBooking() {
    const unitId = await makeUnit(systemPrisma, fx);
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId,
        primaryApplicantId: applicantId,
        coApplicantIds: [],
        bookingDate: new Date('2026-01-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId: ruleId } });
    await svc.plans.createCustomPlan(
      fx.companyId,
      booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-07-02'), amountPaise: L(10_00_000) }] },
      fx.userId,
    );
    return booking;
  }

  it('two accrual runs at once post the period exactly once', async () => {
    const booking = await overdueBooking();
    const asOf = new Date('2026-08-01');
    const results = await behindTableLock('interest_accruals', [
      () => svc.interest.accrueForBooking(fx.companyId, booking.id, asOf),
      () => svc.interest.accrueForBooking(fx.companyId, booking.id, asOf),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    expect(await systemPrisma.interestAccrual.count({ where: { bookingId: booking.id } })).toBe(1);
    const interest = await systemPrisma.ledgerEntry.aggregate({
      where: { bookingId: booking.id, entryType: 'INTEREST' },
      _sum: { signedAmountPaise: true },
    });
    expect(interest._sum.signedAmountPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
  });

  it('a rule change racing an accrual charges the old period once, under the old rule', async () => {
    const booking = await overdueBooking(); // 18% attached, installment due 2026-07-02
    const results = await behindTableLock('interest_accruals', [
      () => svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01')),
      () => rules.setRule(fx.companyId, booking.id, rule24Id, fx.userId),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const rows = await systemPrisma.interestAccrual.findMany({ where: { bookingId: booking.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].interestRuleId).toBe(ruleId);
    expect(rows[0].accruedPaise).toBe(simpleInterest(L(10_00_000), 18, 30));
    expect((await systemPrisma.booking.findUnique({ where: { id: booking.id } })).interestRuleId).toBe(rule24Id);
  });

  it('two rule changes at once: the second sees the first (audit "before" chains)', async () => {
    const booking = await overdueBooking();
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId: null } });
    // The first change waits on its audit row while holding the booking's\n    // lock; the second starts only then.
    const results = await behindTableLock('audit_logs', [
      () => rules.setRule(fx.companyId, booking.id, ruleId, fx.userId),
      () => rules.setRule(fx.companyId, booking.id, rule24Id, fx.userId),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const audit = await systemPrisma.auditLog.findMany({
      where: { entityId: booking.id, action: 'INTEREST_RULE_SET' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit).toHaveLength(2);
    const [first, second] = audit;
    expect(first.before.interestRuleId).toBeNull();
    expect(second.before.interestRuleId).toBe(first.after.interestRuleId);
    expect((await systemPrisma.booking.findUnique({ where: { id: booking.id } })).interestRuleId).toBe(
      second.after.interestRuleId,
    );
  });

  it('a rate edit racing an attach is refused, and the rule attached stays as it was checked', async () => {
    const free = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: `free ${Date.now()}`, rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    const booking = await overdueBooking(); // 18% attached, so the change settles up first
    // The change has checked `free` (active, SIMPLE) and is paused in its
    // settle-up, at the read of interest_accruals, holding `free` FOR SHARE.
    // The edit, started second, must wait on that row (FOR UPDATE) and then
    // see the rule in use. Without the share lock the edit would commit first
    // and the change would attach a rule that is no longer SIMPLE.
    const results = await behindTableLock('interest_accruals', [
      () => rules.setRule(fx.companyId, booking.id, free.id, fx.userId),
      () => masters.update(fx.companyId, free.id, { rateType: 'COMPOUND', ratePercent: 30 }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/attached to 1 booking/);
    const rule = await systemPrisma.interestRule.findUnique({ where: { id: free.id } });
    expect(rule.rateType).toBe('SIMPLE');
    expect(Number(rule.ratePercent)).toBe(18);
    expect((await systemPrisma.booking.findUnique({ where: { id: booking.id } })).interestRuleId).toBe(free.id);
  });
});
