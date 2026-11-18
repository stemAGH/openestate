import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  COMMISSION_ENTRY_TYPE,
  COMMISSION_ACCRUAL_TRIGGER,
  COMMISSION_CLAWBACK_POLICY,
  computeCommissionPaise,
  allocate,
  type BookingCancelledEvent,
  type CommissionEntryTypeValue,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { BrokerCommissionRuleService } from '../brokers/broker-commission-rule.service';

@Injectable()
export class CommissionService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly rules: BrokerCommissionRuleService,
  ) {}

  /**
   * Idempotent, explicitly-triggered, safe to call repeatedly — same
   * contract shape as InterestService.accrueForBooking (frozen; used only
   * as a design template, never imported). No-ops if the booking has no
   * sourcing broker, or if there's nothing new to accrue this call.
   */
  async accrueForBooking(companyId: string, bookingId: string, actorId: string | null) {
    // Never alongside a broker change: the same booking row lock
    // BrokerService.assignToBooking takes, held for the whole accrual (the
    // helpers below reuse this transaction), with the booking read after it.
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // Raw SQL: a row lock has no Prisma API; both ids are bound parameters.
        await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid AND company_id = ${companyId}::uuid FOR NO KEY UPDATE`;
        return this.accrueLocked(companyId, bookingId, actorId);
      }),
    );
  }

  private async accrueLocked(companyId: string, bookingId: string, actorId: string | null) {
    const booking = await this.systemPrisma.booking.findFirst({ where: { id: bookingId, companyId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!booking.brokerId) return null;

    const config = await this.systemPrisma.companyConfig.findFirst({ where: { companyId } });
    const trigger = config?.commissionAccrualTrigger ?? COMMISSION_ACCRUAL_TRIGGER.ON_BOOKING;

    const snapshot = await this.ensureSnapshot(companyId, booking);

    if (trigger === COMMISSION_ACCRUAL_TRIGGER.ON_BOOKING) {
      return this.accrueOnBooking(companyId, booking.id, booking.brokerId, snapshot, actorId);
    }
    return this.accrueOnMilestones(companyId, booking, snapshot, actorId);
  }

  /** Computed ONCE per booking, never re-read for math after (see BrokerBookingCommission's schema doc comment). */
  private async ensureSnapshot(
    companyId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking: any,
  ) {
    const existing = await this.systemPrisma.brokerBookingCommission.findFirst({ where: { companyId, bookingId: booking.id } });
    if (existing) return existing;

    const unit = await this.systemPrisma.unit.findFirst({
      where: { id: booking.unitId, companyId },
      select: { floor: { select: { tower: { select: { projectId: true } } } } },
    });
    const projectId: string | undefined = unit?.floor?.tower?.projectId;

    const rule = await this.rules.findApplicableRule(companyId, booking.brokerId, projectId ?? '');
    if (!rule) {
      throw new BadRequestException(`No active commission rule configured for broker ${booking.brokerId}`);
    }

    const totalCommissionPaise = computeCommissionPaise(booking.agreedPricePaise, rule, rule.slabs);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.brokerBookingCommission.create({
          data: {
            companyId,
            bookingId: booking.id,
            brokerId: booking.brokerId,
            ruleId: rule.id,
            totalCommissionPaise,
          },
        }),
      ),
    );
  }

  private async accrueOnBooking(
    companyId: string,
    bookingId: string,
    brokerId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: any,
    actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const existing = await tx.commissionLedgerEntry.findFirst({
          where: { companyId, bookingId, entryType: COMMISSION_ENTRY_TYPE.ACCRUAL, milestonePercent: null },
        });
        if (existing) return existing;

        return tx.commissionLedgerEntry.create({
          data: {
            companyId,
            brokerId,
            bookingId,
            entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
            signedAmountPaise: snapshot.totalCommissionPaise,
            reason: 'Commission accrued on booking confirmation',
            effectiveDate: new Date(),
            createdById: actorId,
          },
        });
      }),
    );
  }

  private async accrueOnMilestones(
    companyId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: any,
    actorId: string | null,
  ) {
    const rule = await this.systemPrisma.brokerCommissionRule.findFirst({ where: { id: snapshot.ruleId, companyId } });
    const milestones: number[] = (rule?.milestonesJson as number[] | null) ?? [];
    if (milestones.length === 0) return [];

    // Milestone weights are each breakpoint's MARGINAL contribution
    // (e.g. [25,50,100] -> weights [25,25,50]), so `allocate` partitions
    // the frozen snapshot total with no last-paise loss.
    const weights = milestones.map((m, i) => BigInt(m - (milestones[i - 1] ?? 0)));
    const shares = allocate(snapshot.totalCommissionPaise, weights);

    const collectedPercent = await this.computeCollectedPercent(companyId, booking.id, booking.agreedPricePaise);

    const posted: unknown[] = [];
    for (let i = 0; i < milestones.length; i++) {
      if (milestones[i] > collectedPercent) continue;

      // One-way ratchet: once a milestone is crossed and its accrual
      // posted, it is NEVER un-accrued by a later partial receipt reversal
      // that drops collectedPercent back down (same philosophy as
      // InterestService's accrual cursor never retreating). The only path
      // that removes accrued commission is cancellation ->
      // CLAWBACK_REVERSAL (handleBookingCancelled), never a milestone
      // re-check.
      const entry = await runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, async (tx) => {
          const existing = await tx.commissionLedgerEntry.findFirst({
            where: { companyId, bookingId: booking.id, entryType: COMMISSION_ENTRY_TYPE.ACCRUAL, milestonePercent: milestones[i] },
          });
          if (existing) return existing;

          return tx.commissionLedgerEntry.create({
            data: {
              companyId,
              brokerId: booking.brokerId,
              bookingId: booking.id,
              entryType: COMMISSION_ENTRY_TYPE.ACCRUAL,
              signedAmountPaise: shares[i],
              milestonePercent: milestones[i],
              reason: `Commission accrued on reaching ${milestones[i]}% collection`,
              effectiveDate: new Date(),
              createdById: actorId,
            },
          });
        }),
      );
      posted.push(entry);
    }
    return posted;
  }

  /** Mirrors CancellationService's own netReceived computation (frozen; read-only reference, not called). */
  private async computeCollectedPercent(companyId: string, bookingId: string, agreedPricePaise: bigint): Promise<number> {
    if (agreedPricePaise <= 0n) return 0;
    const receipts = await this.systemPrisma.receipt.findMany({
      where: { companyId, bookingId, isReversed: false, clearanceStatus: { in: ['NOT_APPLICABLE', 'CLEARED'] } },
      include: { tdsDeductions: true },
    });
    let netReceived = 0n;
    for (const r of receipts) {
      const tds = r.tdsDeductions.reduce((s: bigint, d: { deductedPaise: bigint }) => s + d.deductedPaise, 0n);
      netReceived += r.grossAmountPaise - tds;
    }
    return Number((netReceived * 10000n) / agreedPricePaise) / 100;
  }

  // ── Clawback (consumes CancellationService's BookingCancelledEvent) ──

  /**
   * Called from BookingController.cancel() (commit 2) after
   * cancellationService.cancel() succeeds, inside the SAME outer
   * transaction — see CLAUDE.md Phase 5 decisions for the withTenantTx
   * nesting-reuse mechanism that makes this transactional without
   * touching CancellationService. Not wired to any controller yet in
   * this commit — tested by direct call.
   *
   * Always reverses whatever's still unpaid-accrued for this booking
   * (unearned commission is never owed after cancellation, regardless of
   * clawback policy) — then, separately, if anything was actually
   * disbursed, either recovers it (RECOVER) or writes it off with a
   * mandatory reason (WRITE_OFF). Both steps derive their amount from the
   * booking's CURRENT ledger state (never a separately-tracked counter),
   * same "post whatever's needed to reach a computed target" idea as
   * CancellationService's own settlement entry.
   */
  async handleBookingCancelled(companyId: string, event: BookingCancelledEvent, brokerId: string, actorId: string | null) {
    const config = await this.systemPrisma.companyConfig.findFirst({ where: { companyId } });
    const policy = config?.commissionClawbackPolicy ?? COMMISSION_CLAWBACK_POLICY.RECOVER;

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const entries = await tx.commissionLedgerEntry.findMany({ where: { companyId, bookingId: event.bookingId } });
        const outstandingForBooking = entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
        const netPaid = entries
          .filter((e: { entryType: string }) => e.entryType === COMMISSION_ENTRY_TYPE.PAYMENT)
          .reduce((s: bigint, e: { signedAmountPaise: bigint }) => s - e.signedAmountPaise, 0n);

        const posted: unknown[] = [];

        if (outstandingForBooking !== 0n) {
          posted.push(
            await this.postClawback(tx, companyId, brokerId, event.bookingId, COMMISSION_ENTRY_TYPE.CLAWBACK_REVERSAL, -outstandingForBooking, {
              reason: `Unearned commission reversed on booking cancellation (${event.cancellationType})`,
              actorId,
            }),
          );
        }

        if (netPaid > 0n) {
          if (policy === COMMISSION_CLAWBACK_POLICY.WRITE_OFF) {
            posted.push(
              await this.postClawback(tx, companyId, brokerId, event.bookingId, COMMISSION_ENTRY_TYPE.CLAWBACK_WRITEOFF, 0n, {
                reason: `Already-paid commission (${netPaid} paise) written off on booking cancellation (${event.cancellationType}) — company policy: WRITE_OFF`,
                actorId,
              }),
            );
          } else {
            posted.push(
              await this.postClawback(tx, companyId, brokerId, event.bookingId, COMMISSION_ENTRY_TYPE.CLAWBACK_RECOVERY, -netPaid, {
                reason: `Already-paid commission recovered on booking cancellation (${event.cancellationType}) — company policy: RECOVER`,
                actorId,
              }),
            );
          }
        }

        return posted;
      }),
    );
  }

  /**
   * Shared clawback-entry poster — also the direct test hook for required
   * change #6a (CLAWBACK_WRITEOFF with no reason must be rejected).
   */
  async postClawback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    brokerId: string,
    bookingId: string,
    entryType: CommissionEntryTypeValue,
    signedAmountPaise: bigint,
    opts: { reason?: string; actorId: string | null },
  ) {
    if (entryType === COMMISSION_ENTRY_TYPE.CLAWBACK_WRITEOFF && !opts.reason) {
      // A zero-amount audited entry with no reason is indistinguishable
      // from a bug — refuse to post one.
      throw new BadRequestException('CLAWBACK_WRITEOFF requires a reason');
    }
    return tx.commissionLedgerEntry.create({
      data: {
        companyId,
        brokerId,
        bookingId,
        entryType,
        signedAmountPaise,
        reason: opts.reason ?? null,
        effectiveDate: new Date(),
        createdById: opts.actorId,
      },
    });
  }

  async balance(companyId: string, brokerId: string): Promise<bigint> {
    const entries = await this.systemPrisma.commissionLedgerEntry.findMany({ where: { companyId, brokerId } });
    return entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
  }

  /** Same as balance(), but reads inside an already-open transaction (used by CommissionPaymentService.request/pay to avoid a check-then-insert race). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async balanceInTx(tx: any, companyId: string, brokerId: string): Promise<bigint> {
    const entries = await tx.commissionLedgerEntry.findMany({ where: { companyId, brokerId } });
    return entries.reduce((s: bigint, e: { signedAmountPaise: bigint }) => s + e.signedAmountPaise, 0n);
  }
}
