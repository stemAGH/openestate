/**
 * Refunds and bounced refund cheques (v0.10.1). A bounced refund goes back to
 * REQUESTED: paying it again needs a new approval, which re-checks what the
 * booking is owed back and posts the approval debit again. Before this, the
 * bounced refund went back to APPROVED while the ledger re-credited the same
 * money as owed, so it could be refunded twice.
 *
 * - A fixed case: the exact sequence that paid ₹17,99,500 against ₹8,99,500.
 * - A refused re-approval names both amounts; the refund can be rejected and
 *   re-requested for the correct amount.
 * - The over-refund upgrade report compares payment vouchers too.
 * - A property test over random request / approve / reject / pay / bounce
 *   sequences on two bookings, checking after every step: (i) non-bounced
 *   refund vouchers never exceed what the booking is owed back; (ii) the
 *   ledger's refund entries equal the non-bounced vouchers plus the approved,
 *   unpaid refunds; (iii) the ledger only grows (no entry changes or goes);
 *   (iv) approved refunds, net of bounced cheques, never exceed what is owed back.
 *
 * numRuns: as the ledger property test (CI 2000, local 500, PROPERTY_NUM_RUNS
 * overrides). Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { HttpException } from '@nestjs/common';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { makeClients, buildServices, seedCompany, makeUnit, makeApplicant, cleanupCompany, type Services, type CompanyFixture } from './helpers/postsales-harness';
import { holdAdvisoryLock, countBlockedBehind } from './helpers/row-lock-barrier';
import * as sync from '../../../packages/db/prisma/sync-permissions';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const L = (rupees: number) => BigInt(rupees) * 100n;
const NUM_RUNS = process.env.PROPERTY_NUM_RUNS ? Number(process.env.PROPERTY_NUM_RUNS) : process.env.CI ? 2000 : 500;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const overRefundedBookings = (sync as any).overRefundedBookings as (c: unknown, s: { companyId: string }) => Promise<Array<{ bookings: Array<{ bookingNumber: string; overPaise: string }> }>>;

describeIf('refunds and bounced refund cheques', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;
  let ruleId: string;
  // reject() is new with this change; reached through `any` so the file compiles before it exists.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refunds = () => svc.refunds as any;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { chequeBounceChargePaise: L(500) } });
    ruleId = (await systemPrisma.cancellationRule.create({
      data: { companyId: fx.companyId, name: '10%', deductionType: 'PERCENT', deductionPercent: 10 },
    })).id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  }, 300_000);

  /** ₹10,00,000 received, cancelled with 10% deducted: ₹9,00,000 owed back. */
  async function cancelledOwing() {
    const b = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId: await makeUnit(systemPrisma, fx), primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId, b.id,
      { name: 'P', isCustom: true, installments: [{ label: 'All', dueDate: new Date('2026-06-15'), amountPaise: b.agreedPricePaise }] },
      fx.userId,
    );
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: b.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000),
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: L(10_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.cancellations.cancel(fx.companyId, b.id, { cancellationType: 'CANCEL', cancellationRuleId: ruleId }, fx.userId);
    return b;
  }

  /**
   * The same end state as cancelledOwing(), seeded in one step for the property
   * test (thousands of bookings): a CANCELLED booking with the four ledger
   * entries the real booking, receipt and cancellation write (₹9,00,000 owed
   * back). Every refund operation in the test still runs through the services.
   */
  let unitForSeeds: string;
  let applicantForSeeds: string;
  let seedSeq = 0;
  async function seededCancelledOwing() {
    unitForSeeds ??= await makeUnit(systemPrisma, fx);
    applicantForSeeds ??= await makeApplicant(systemPrisma, fx.companyId);
    const b = await systemPrisma.booking.create({
      data: {
        companyId: fx.companyId, unitId: unitForSeeds, primaryApplicantId: applicantForSeeds, bookingNumber: `PROP-${Date.now()}-${seedSeq++}`,
        status: 'CANCELLED', agreedPricePaise: L(10_00_000), bookingDate: new Date('2026-06-01'), createdById: fx.userId,
      },
    });
    const at = new Date('2026-06-16');
    await systemPrisma.ledgerEntry.createMany({
      data: [
        ['CHARGE', L(10_00_000)], ['RECEIPT_ALLOC', -L(10_00_000)], ['CANCELLATION_DEDUCTION', L(1_00_000)], ['CANCELLATION_SETTLEMENT', -L(10_00_000)],
      ].map(([entryType, signedAmountPaise]) => ({ companyId: fx.companyId, bookingId: b.id, entryType, signedAmountPaise, effectiveDate: at })),
    });
    return b;
  }

  /** The three invariants for one booking; returns the ledger snapshot for the append-only check. */
  async function checkInvariants(bookingId: string, previous?: Map<string, bigint>) {
    const entries: Array<{ id: string; entryType: string; signedAmountPaise: bigint }> = await systemPrisma.ledgerEntry.findMany({
      where: { bookingId }, select: { id: true, entryType: true, signedAmountPaise: true },
    });
    const balance = entries.reduce((s, e) => s + e.signedAmountPaise, 0n);
    const refundNet = entries
      .filter((e) => e.entryType === 'REFUND_APPROVED' || e.entryType === 'REFUND_BOUNCE_REVERSAL')
      .reduce((s, e) => s + e.signedAmountPaise, 0n);
    const owedWithoutRefunds = refundNet - balance > 0n ? refundNet - balance : 0n;
    const vouchers: Array<{ amountPaise: bigint }> = await systemPrisma.paymentVoucher.findMany({
      where: { bookingId, status: { not: 'BOUNCED' } }, select: { amountPaise: true },
    });
    const vouchersOut = vouchers.reduce((s, v) => s + v.amountPaise, 0n);
    const approvedUnpaid: Array<{ amountPaise: bigint }> = await systemPrisma.refund.findMany({
      where: { bookingId, status: 'APPROVED' }, select: { amountPaise: true },
    });
    const approvedOpen = approvedUnpaid.reduce((s, r) => s + r.amountPaise, 0n);

    // (i) never pay out more than the booking is owed back
    expect(vouchersOut, 'vouchers out vs owed back').toBeLessThanOrEqual(owedWithoutRefunds);
    // (iv) approved refunds (net of bounced cheques) never exceed what the booking is owed back
    expect(refundNet, 'approved refunds vs owed back').toBeLessThanOrEqual(owedWithoutRefunds);
    // (ii) the ledger's refund entries are exactly what was paid out plus what is approved and unpaid
    expect(refundNet, 'ledger refunds vs vouchers + approved unpaid').toBe(vouchersOut + approvedOpen);
    // (iii) append-only: every earlier entry is still there, unchanged
    const now = new Map(entries.map((e) => [e.id, e.signedAmountPaise]));
    if (previous) for (const [id, amount] of previous) expect(now.get(id), `ledger entry ${id}`).toBe(amount);
    return now;
  }

  /** Refusals are expected; anything that isn't an HTTP refusal is a bug. */
  async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof HttpException) return false;
      throw e;
    }
  }

  it('fixed case: a bounced refund needs a new approval; the ₹17,99,500 sequence now pays out only what is owed', async () => {
    const b = await cancelledOwing();
    const r1 = await svc.refunds.request(fx.companyId, b.id, { amountPaise: L(9_00_000), mode: 'CHEQUE' }, fx.userId);
    await svc.refunds.approve(fx.companyId, r1.id, fx.userId);
    const v1 = await svc.refunds.pay(fx.companyId, r1.id, { mode: 'CHEQUE', instrumentNumber: 'C1' }, fx.userId);
    await svc.refunds.voucherBounced(fx.companyId, v1.id, fx.userId);
    expect((await systemPrisma.refund.findUnique({ where: { id: r1.id } })).status).toBe('REQUESTED');
    // Owed back is now ₹8,99,500 (the ₹500 bounce charge), and the bounced ₹9,00,000 is an open request.
    await expect(svc.refunds.request(fx.companyId, b.id, { amountPaise: L(8_99_500), mode: 'NEFT' }, fx.userId)).rejects.toThrow(/exceeds/);
    // Paying the bounced refund again without a new approval is refused.
    await expect(svc.refunds.pay(fx.companyId, r1.id, { mode: 'NEFT' }, fx.userId)).rejects.toThrow(/only APPROVED/);
    await checkInvariants(b.id);
    const out = await systemPrisma.paymentVoucher.findMany({ where: { bookingId: b.id, status: { not: 'BOUNCED' } } });
    expect(out).toHaveLength(0);
  });

  it('a re-approval refused because less is owed now names both amounts; reject and re-request the correct amount', async () => {
    const b = await cancelledOwing();
    const r1 = await svc.refunds.request(fx.companyId, b.id, { amountPaise: L(9_00_000), mode: 'CHEQUE' }, fx.userId);
    await svc.refunds.approve(fx.companyId, r1.id, fx.userId);
    const v1 = await svc.refunds.pay(fx.companyId, r1.id, { mode: 'CHEQUE', instrumentNumber: 'C1' }, fx.userId);
    await svc.refunds.voucherBounced(fx.companyId, v1.id, fx.userId);

    const refused = svc.refunds.approve(fx.companyId, r1.id, fx.userId);
    await expect(refused).rejects.toThrow(/₹9,00,000\.00/);
    await expect(svc.refunds.approve(fx.companyId, r1.id, fx.userId)).rejects.toThrow(/₹8,99,500\.00/);
    await expect(svc.refunds.approve(fx.companyId, r1.id, fx.userId)).rejects.toThrow(/reject/i);

    await refunds().reject(fx.companyId, r1.id, 'amount owed fell after the bounce charge', fx.userId);
    expect((await systemPrisma.refund.findUnique({ where: { id: r1.id } })).status).toBe('REJECTED');
    const audit = await systemPrisma.auditLog.findFirst({ where: { entityId: r1.id, action: 'REFUND_REJECTED' } });
    expect(audit?.after).toMatchObject({ reason: 'amount owed fell after the bounce charge', amountPaise: String(L(9_00_000)) });
    const r2 = await svc.refunds.request(fx.companyId, b.id, { amountPaise: L(8_99_500), mode: 'NEFT' }, fx.userId);
    await svc.refunds.approve(fx.companyId, r2.id, fx.userId);
    await svc.refunds.pay(fx.companyId, r2.id, { mode: 'NEFT' }, fx.userId);
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(0n);
    await checkInvariants(b.id);
    // Only a REQUESTED refund can be rejected.
    await expect(refunds().reject(fx.companyId, r2.id, 'late', fx.userId)).rejects.toThrow(/only REQUESTED/);
  });

  it('a refund cheque bounce waits on the booking refund lock, like request, approval and payment', async () => {
    const b = await cancelledOwing();
    const r = await svc.refunds.request(fx.companyId, b.id, { amountPaise: L(1_00_000), mode: 'CHEQUE' }, fx.userId);
    await svc.refunds.approve(fx.companyId, r.id, fx.userId);
    const v = await svc.refunds.pay(fx.companyId, r.id, { mode: 'CHEQUE', instrumentNumber: 'L1' }, fx.userId);
    const barrier = await holdAdvisoryLock(systemPrisma, `refund:${b.id}`);
    const p = svc.refunds.voucherBounced(fx.companyId, v.id, fx.userId);
    const blocked = await countBlockedBehind(systemPrisma, barrier.pid, 1);
    await barrier.release();
    await p;
    expect(blocked).toBe(1);
  }, 30_000);

  it('upgrade report: a refund paid twice through a bounced cheque is listed from the vouchers, though the ledger balances', async () => {
    const b = await cancelledOwing();
    const c = { companyId: fx.companyId, bookingId: b.id };
    // The end state an older release could reach (seeded directly).
    const r1 = await systemPrisma.refund.create({ data: { ...c, amountPaise: L(9_00_000), status: 'PAID', createdById: fx.userId } });
    const r2 = await systemPrisma.refund.create({ data: { ...c, amountPaise: L(8_99_500), status: 'PAID', createdById: fx.userId } });
    const entry = (entryType: string, paise: bigint) =>
      systemPrisma.ledgerEntry.create({ data: { ...c, entryType, signedAmountPaise: paise, reason: 'seeded', effectiveDate: new Date('2026-07-01') } });
    await entry('REFUND_APPROVED', L(9_00_000));
    await entry('REFUND_BOUNCE_REVERSAL', -L(9_00_000));
    await entry('BOUNCE_CHARGE', L(500));
    await entry('REFUND_APPROVED', L(8_99_500));
    const voucher = (refundId: string, paise: bigint, status: string) =>
      systemPrisma.paymentVoucher.create({ data: { ...c, refundId, amountPaise: paise, mode: 'CHEQUE', status, createdById: fx.userId } });
    await voucher(r1.id, L(9_00_000), 'BOUNCED');
    await voucher(r2.id, L(8_99_500), 'ISSUED');
    await voucher(r1.id, L(9_00_000), 'ISSUED');
    expect(await svc.ledger.balance(fx.companyId, b.id)).toBe(0n);

    const rows = await overRefundedBookings(systemPrisma, { companyId: fx.companyId });
    const listed = rows.flatMap((r) => r.bookings);
    expect(listed).toContainEqual({ bookingNumber: b.bookingNumber, overPaise: String(L(9_00_000)) });
  });

  it(`property: random refund sequences on two bookings keep the four invariants (${NUM_RUNS} runs)`, async () => {
    const cmd = fc.oneof(
      fc.record({ t: fc.constant('request' as const), b: fc.integer({ min: 0, max: 1 }), rupees: fc.integer({ min: 1, max: 11_00_000 }) }),
      fc.record({ t: fc.constant('approve' as const), b: fc.integer({ min: 0, max: 1 }), k: fc.nat(5) }),
      fc.record({ t: fc.constant('reject' as const), b: fc.integer({ min: 0, max: 1 }), k: fc.nat(5) }),
      fc.record({ t: fc.constant('pay' as const), b: fc.integer({ min: 0, max: 1 }), k: fc.nat(5) }),
      fc.record({ t: fc.constant('bounce' as const), b: fc.integer({ min: 0, max: 1 }), k: fc.nat(5) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 10 }), async (cmds) => {
        const bookings = [await seededCancelledOwing(), await seededCancelledOwing()];
        const snaps: Array<Map<string, bigint> | undefined> = [undefined, undefined];
        for (const c of cmds) {
          const b = bookings[c.b];
          const list: Array<{ id: string }> = await systemPrisma.refund.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: 'asc' } });
          const pick = () => (list.length ? list[(c as { k: number }).k % list.length].id : null);
          if (c.t === 'request') {
            await attempt(() => svc.refunds.request(fx.companyId, b.id, { amountPaise: L(c.rupees), mode: 'CHEQUE' }, fx.userId));
          } else if (c.t === 'approve' && pick()) {
            await attempt(() => svc.refunds.approve(fx.companyId, pick()!, fx.userId));
          } else if (c.t === 'reject' && pick()) {
            await attempt(() => refunds().reject(fx.companyId, pick()!, 'test', fx.userId));
          } else if (c.t === 'pay' && pick()) {
            await attempt(() => svc.refunds.pay(fx.companyId, pick()!, { mode: 'CHEQUE', instrumentNumber: 'P' }, fx.userId));
          } else if (c.t === 'bounce') {
            const issued: Array<{ id: string }> = await systemPrisma.paymentVoucher.findMany({ where: { bookingId: b.id, status: 'ISSUED' }, orderBy: { createdAt: 'asc' } });
            if (issued.length) await attempt(() => svc.refunds.voucherBounced(fx.companyId, issued[c.k % issued.length].id, fx.userId));
          }
          // Both bookings, after every step: the untouched one is the control.
          for (const i of [0, 1]) snaps[i] = await checkInvariants(bookings[i].id, snaps[i]);
        }
      }),
      // The ₹17,99,500 sequence on booking 0, always run first.
      {
        numRuns: NUM_RUNS,
        examples: [[[
          { t: 'request', b: 0, rupees: 9_00_000 }, { t: 'approve', b: 0, k: 0 }, { t: 'pay', b: 0, k: 0 }, { t: 'bounce', b: 0, k: 0 },
          { t: 'request', b: 0, rupees: 8_99_500 }, { t: 'approve', b: 0, k: 1 }, { t: 'pay', b: 0, k: 1 }, { t: 'pay', b: 0, k: 0 },
        ]]],
      },
    );
  }, 3_600_000);
});
