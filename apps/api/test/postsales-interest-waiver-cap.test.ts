/**
 * QA-010: an interest waiver was posted for any amount on any booking. It is
 * now limited to the interest charged less earlier waivers, checked under the
 * booking's interest lock, and refused on a booking that no longer accrues
 * (cancelled, surrendered, transferred out). An upgrade report lists bookings
 * already waived above the interest charged.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { Clock } from '@openestate/shared';
import { makeClients, buildServices, seedCompany, makeUnit, makeApplicant, cleanupCompany, type Services, type CompanyFixture } from './helpers/postsales-harness';
import { holdAdvisoryLock, countBlockedBehind } from './helpers/row-lock-barrier';
import * as sync from '../../../packages/db/prisma/sync-permissions';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const L = (rupees: number) => BigInt(rupees) * 100n;
// Through the module object, so this file loads before the report exists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const overWaivedBookings = (sync as any).overWaivedBookings as
  | ((c: unknown, s: { companyId: string }) => Promise<Array<{ count: number; bookings: Array<{ bookingNumber: string; overPaise: string }> }>>)
  | undefined;

describeIf('interest waiver cap (QA-010)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;
  let ruleId: string;
  const clock: Clock = { now: () => new Date('2026-08-01T00:00:00.000Z') };

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, clock);
    fx = await seedCompany(systemPrisma);
    ruleId = (await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: '18% simple', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    })).id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  /** A booking with ₹10,00,000 overdue 30 days and that interest accrued; returns it with the interest charged. */
  async function withInterest() {
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId: await makeUnit(systemPrisma, fx), primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-01-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId: ruleId } });
    await svc.plans.createCustomPlan(
      fx.companyId, booking.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-07-02'), amountPaise: booking.agreedPricePaise }] },
      fx.userId,
    );
    const res = await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2026-08-01'));
    expect(res.postedPaise).toBeGreaterThan(0n);
    return { booking, charged: res.postedPaise };
  }

  const waive = (bookingId: string, amountPaise: bigint) =>
    svc.interest.waiveInterest(fx.companyId, bookingId, { amountPaise, reason: 'goodwill' }, fx.userId);

  it('waives exactly the interest charged; one paisa more is refused (409) with the waivable amount', async () => {
    const a = await withInterest();
    await expect(waive(a.booking.id, a.charged + 1n)).rejects.toBeInstanceOf(ConflictException);
    await expect(waive(a.booking.id, a.charged + 1n)).rejects.toThrow(new RegExp(String(a.charged)));
    await waive(a.booking.id, a.charged);
  });

  it('the cap is cumulative: a second waiver gets only what the first left', async () => {
    const a = await withInterest();
    const half = a.charged / 2n;
    await waive(a.booking.id, half);
    await expect(waive(a.booking.id, a.charged - half + 1n)).rejects.toBeInstanceOf(ConflictException);
    await waive(a.booking.id, a.charged - half);
    await expect(waive(a.booking.id, 1n)).rejects.toBeInstanceOf(ConflictException);
  });

  it('a booking with no interest charged has nothing to waive', async () => {
    const booking = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId: await makeUnit(systemPrisma, fx), primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-01-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(1_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    await expect(waive(booking.id, 1n)).rejects.toBeInstanceOf(ConflictException);
  });

  it('is refused on a cancelled booking, even with interest charged before', async () => {
    const a = await withInterest();
    await svc.cancellations.cancel(fx.companyId, a.booking.id, { cancellationType: 'CANCEL' }, fx.userId);
    const before = await svc.ledger.balance(fx.companyId, a.booking.id);
    await expect(waive(a.booking.id, 1n)).rejects.toBeInstanceOf(ConflictException);
    expect(await svc.ledger.balance(fx.companyId, a.booking.id)).toBe(before);
  });

  it('forced interleaving: two waivers that fit alone but not together wait on the interest lock; one is refused', async () => {
    const a = await withInterest();
    const share = (a.charged * 2n) / 3n; // each fits; both together exceed the interest charged
    const barrier = await holdAdvisoryLock(systemPrisma, `interest:${a.booking.id}`);
    const p1 = waive(a.booking.id, share);
    const p2 = waive(a.booking.id, share);
    const blocked = await countBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.allSettled([p1, p2]);
    expect(blocked).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const waived = await systemPrisma.ledgerEntry.aggregate({
      where: { bookingId: a.booking.id, entryType: 'INTEREST_WAIVER' }, _sum: { signedAmountPaise: true },
    });
    expect(-waived._sum.signedAmountPaise).toBe(share);
  }, 30_000);

  it('upgrade report: lists a booking waived above the interest charged, and not one waived within it', async () => {
    const over = await withInterest();
    // What an older release allowed: a waiver larger than the interest charged.
    await systemPrisma.ledgerEntry.create({
      data: { companyId: fx.companyId, bookingId: over.booking.id, entryType: 'INTEREST_WAIVER', signedAmountPaise: -(over.charged + L(100)), reason: 'old waiver', effectiveDate: new Date('2026-08-01') },
    });
    const within = await withInterest();
    await waive(within.booking.id, within.charged);

    expect(typeof overWaivedBookings).toBe('function');
    const rows = await overWaivedBookings!(systemPrisma, { companyId: fx.companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0].bookings).toEqual([{ bookingNumber: over.booking.bookingNumber, overPaise: String(L(100)) }]);
    expect(rows[0].count).toBe(1);
  });
});
