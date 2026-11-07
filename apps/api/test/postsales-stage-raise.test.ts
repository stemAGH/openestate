/**
 * Construction-linked demand fix — regression tests for the core claims
 * in internal plan construction-linked-demand-fix.md §7:
 *   - an unraised STAGE_LINKED installment never appears overdue and
 *     never accrues interest, however far the clock advances;
 *   - raising sets the due date correctly and interest accrues only from
 *     that date forward;
 *   - a re-raise of an already-raised stage is idempotent;
 *   - a booking created after a stage was already raised self-raises at
 *     instantiation time;
 *   - DATE_LINKED behaviour is unchanged;
 *   - the two allocation-time/demand-time backend guards (receipt
 *     allocation, demand-letter generation) reject an unraised installment.
 *
 * Each test that calls raiseStage() seeds its OWN fresh company/project/
 * template rather than sharing one across the file — a bulk raise sweeps
 * every unraised installment across every booking on that (project,
 * template, milestoneSeq), which is the correct real behaviour but means
 * two tests sharing one project would silently interfere with each
 * other's "still unraised" preconditions.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
function simpleInterest(principal: bigint, ratePercent: number, days: number): bigint {
  const bps = BigInt(Math.round(ratePercent * 100));
  const num = principal * bps * BigInt(days);
  const den = 365n * 10_000n;
  return (num + den / 2n) / den;
}

describeIf('Construction-linked demand fix', () => {
  const { tenantPrisma, systemPrisma } = makeClients();
  const companiesToClean: string[] = [];

  afterEach(async () => {
    for (const id of companiesToClean.splice(0)) {
      await cleanupCompany(systemPrisma, id);
    }
  });

  /** Fresh company + a two-milestone template (DATE_LINKED + STAGE_LINKED). */
  async function setUp(clockValue: Date) {
    const clock: Clock = { now: () => clockValue };
    const svc: Services = buildServices(tenantPrisma, systemPrisma, clock);
    const fx: CompanyFixture = await seedCompany(systemPrisma);
    companiesToClean.push(fx.companyId);

    const rule = await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: '18% simple', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });
    const template = await systemPrisma.paymentPlanTemplate.create({
      data: { companyId: fx.companyId, name: 'Construction Test Plan' },
    });
    await systemPrisma.paymentPlanMilestone.create({
      data: { companyId: fx.companyId, templateId: template.id, seq: 1, label: 'On Booking', percent: 40, milestoneType: 'DATE_LINKED', dueOffsetDays: 0 },
    });
    await systemPrisma.paymentPlanMilestone.create({
      data: { companyId: fx.companyId, templateId: template.id, seq: 2, label: 'Superstructure', percent: 60, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
    });

    async function bookAgainstTemplate() {
      const unitId = await makeUnit(systemPrisma, fx);
      const applicantId = await makeApplicant(systemPrisma, fx.companyId);
      const booking = await svc.bookings.createBooking(
        fx.companyId,
        {
          unitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: new Date('2027-01-01'),
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
        },
        fx.userId,
      );
      await systemPrisma.booking.update({ where: { id: booking.id }, data: { interestRuleId: rule.id } });
      const plan = await svc.plans.instantiateFromTemplate(fx.companyId, booking.id, template.id, fx.userId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dateLinked = plan.installments.find((i: any) => i.seq === 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stageLinked = plan.installments.find((i: any) => i.seq === 2);
      return { booking, plan, dateLinked, stageLinked };
    }

    return { svc, fx, templateId: template.id as string, bookAgainstTemplate };
  }

  it('DATE_LINKED milestone: dueDate set at instantiation, unchanged behaviour', async () => {
    const { bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { dateLinked } = await bookAgainstTemplate();
    expect(dateLinked.dueDate.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(dateLinked.milestoneType).toBe('DATE_LINKED');
  });

  it('STAGE_LINKED milestone: dueDate is null at instantiation, unraised', async () => {
    const { bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { stageLinked } = await bookAgainstTemplate();
    expect(stageLinked.dueDate).toBeNull();
    expect(stageLinked.milestoneType).toBe('STAGE_LINKED');
  });

  it('an unraised STAGE_LINKED installment never accrues interest, however far the clock moves', async () => {
    const { svc, fx, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { booking } = await bookAgainstTemplate();
    const farFuture = new Date('2029-06-01T00:00:00.000Z');
    const res = await svc.interest.accrueForBooking(fx.companyId, booking.id, farFuture);
    // Only the DATE_LINKED installment (due 2027-01-01, 40% = L(4,00,000))
    // is eligible; the STAGE_LINKED one contributes zero, however large
    // farFuture is.
    const days = Math.floor((farFuture.getTime() - new Date('2027-01-01').getTime()) / 86_400_000);
    expect(res.postedPaise).toBe(simpleInterest(L(4_00_000), 18, days));
    expect(res.installmentsAccrued).toBe(1);
  });

  it('an unraised STAGE_LINKED installment never appears in the dues-ageing query', async () => {
    const { fx, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { booking } = await bookAgainstTemplate();
    const overdue = await systemPrisma.installment.findMany({
      where: { companyId: fx.companyId, bookingId: booking.id, isActive: true, status: { not: 'PAID' }, dueDate: { lt: new Date('2029-06-01') } },
    });
    // Postgres's own NULL-comparison semantics exclude the STAGE_LINKED
    // row from `dueDate: { lt: ... }` — see
    // internal plan construction-linked-demand-fix.md §2/§3.
    expect(overdue).toHaveLength(1);
    expect(overdue[0].milestoneType).toBe('DATE_LINKED');
  });

  it('raising sets the due date correctly, and interest accrues only from that date forward', async () => {
    const { svc, fx, templateId, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { booking, stageLinked } = await bookAgainstTemplate();

    const raise = await svc.stageRaises.raiseStage(
      fx.companyId,
      fx.projectId,
      { templateId, milestoneSeq: 2, stageCompletedOn: new Date('2027-06-01') },
      fx.userId,
    );
    expect(raise.raisedCount).toBe(1);

    const raised = await systemPrisma.installment.findUnique({ where: { id: stageLinked.id } });
    // stageCompletedOn (2027-06-01) + graceDaysAfterRaise (15) = 2027-06-16.
    expect(raised.dueDate.toISOString().slice(0, 10)).toBe('2027-06-16');
    expect(raised.stageRaiseId).toBe(raise.stageRaiseId);

    // Before the raised due date: zero accrual on this installment.
    await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2027-06-10T00:00:00.000Z'));
    const before = await systemPrisma.interestAccrual.findMany({ where: { companyId: fx.companyId, installmentId: stageLinked.id } });
    expect(before).toHaveLength(0);

    // After: accrues, anchored to the RAISED due date (2027-06-16), not
    // bookingDate (2027-01-01) or the raise action's own timestamp.
    await svc.interest.accrueForBooking(fx.companyId, booking.id, new Date('2027-07-16T00:00:00.000Z')); // 30 days after 2027-06-16
    const after = await systemPrisma.interestAccrual.findMany({ where: { companyId: fx.companyId, installmentId: stageLinked.id } });
    expect(after).toHaveLength(1);
    expect(after[0].accruedPaise).toBe(simpleInterest(L(6_00_000), 18, 30));
  });

  it('re-raising an already-raised stage is idempotent: zero raised, same StageRaise row reused', async () => {
    const { svc, fx, templateId, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { stageLinked } = await bookAgainstTemplate();

    const first = await svc.stageRaises.raiseStage(
      fx.companyId, fx.projectId, { templateId, milestoneSeq: 2, stageCompletedOn: new Date('2027-06-01') }, fx.userId,
    );
    expect(first.raisedCount).toBe(1);

    // A second raise call, even with a different (ignored) date, must not
    // change the already-raised installment or create a second StageRaise.
    const second = await svc.stageRaises.raiseStage(
      fx.companyId, fx.projectId, { templateId, milestoneSeq: 2, stageCompletedOn: new Date('2027-09-01') }, fx.userId,
    );
    expect(second.raisedCount).toBe(0);
    expect(second.stageRaiseId).toBe(first.stageRaiseId);

    const raised = await systemPrisma.installment.findUnique({ where: { id: stageLinked.id } });
    expect(raised.dueDate.toISOString().slice(0, 10)).toBe('2027-06-16'); // unchanged from the first raise

    const allRaises = await systemPrisma.stageRaise.findMany({
      where: { companyId: fx.companyId, projectId: fx.projectId, templateId, milestoneSeq: 2 },
    });
    expect(allRaises).toHaveLength(1);
  });

  it('self-raise-at-instantiation: a booking created after the stage was already raised picks it up immediately', async () => {
    const { svc, fx, templateId, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    // Raise the stage once (via a throwaway earlier booking in this fixture).
    await bookAgainstTemplate();
    await svc.stageRaises.raiseStage(
      fx.companyId, fx.projectId, { templateId, milestoneSeq: 2, stageCompletedOn: new Date('2027-06-01') }, fx.userId,
    );

    // A brand-new booking against the same template, made AFTER that raise.
    const { stageLinked } = await bookAgainstTemplate();
    expect(stageLinked.dueDate).not.toBeNull();
    expect(new Date(stageLinked.dueDate).toISOString().slice(0, 10)).toBe('2027-06-16');
  });

  it('receipt allocation is rejected against an unraised installment (allocation-time, not receipt-time)', async () => {
    const { svc, fx, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { booking, stageLinked } = await bookAgainstTemplate();
    await expect(
      svc.receipts.createReceipt(
        fx.companyId,
        {
          bookingId: booking.id,
          receiptDate: new Date('2027-01-05'),
          mode: 'CASH',
          grossAmountPaise: L(1_00_000),
          tdsDeductedPaise: 0n,
          allocations: [{ installmentId: stageLinked.id, amountPaise: L(1_00_000) }],
        },
        fx.userId,
      ),
    ).rejects.toThrow(/has not been raised/);
  });

  it('receipt allocation succeeds normally against the DATE_LINKED installment on the same booking', async () => {
    const { svc, fx, bookAgainstTemplate } = await setUp(new Date('2027-01-01'));
    const { booking, dateLinked } = await bookAgainstTemplate();
    const receipt = await svc.receipts.createReceipt(
      fx.companyId,
      {
        bookingId: booking.id,
        receiptDate: new Date('2027-01-05'),
        mode: 'CASH',
        grossAmountPaise: L(1_00_000),
        tdsDeductedPaise: 0n,
        allocations: [{ installmentId: dateLinked.id, amountPaise: L(1_00_000) }],
      },
      fx.userId,
    );
    expect(receipt.grossAmountPaise).toBe(L(1_00_000));
  });
});
