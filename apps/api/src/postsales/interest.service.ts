import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type BookingStatus } from '@prisma/client';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  BOOKING_STATUS,
  LEDGER_ENTRY_TYPE,
  INTEREST_RATE_TYPE,
  roundedDiv,
  type Clock,
  type InterestWaiverDto,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { CLOCK } from '../common/clock.provider';
import { LedgerService } from './ledger.service';

const DAY_MS = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return Math.floor((toUtcMidnight(to) - toUtcMidnight(from)) / DAY_MS);
}
function toUtcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Only these bookings accrue (a cancelled or transferred-out booking is settled). */
export const ACCRUING_STATUSES: BookingStatus[] = [
  BOOKING_STATUS.BOOKED,
  BOOKING_STATUS.ALLOTTED,
  BOOKING_STATUS.REGISTERED,
];

/**
 * Per-booking lock for everything that reads or changes a booking's interest:
 * accrual and the rule change (BookingInterestRuleService). Transaction-scoped;
 * re-entrant within one transaction, so a rule change can accrue inside it.
 */
export async function lockBookingInterest(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('interest:' || ${bookingId}::text, 0))`;
}

export interface AccrualResult {
  bookingId: string;
  postedPaise: bigint;
  installmentsAccrued: number;
}

/**
 * Delay-interest accrual on overdue installments.
 *
 * Model (documented for the hand-computed fixtures): each accrual run advances
 * a per-installment cursor from its due date (or the last accrual's periodEnd)
 * up to `asOf`, and posts interest on the installment's CURRENT outstanding
 * (amount − allocated) for the days in that window. A partial payment therefore
 * lowers the principal for all FUTURE windows (declining balance from the
 * allocation forward) without retroactively re-segmenting past interest.
 *
 * SIMPLE:   interest = outstanding · rate · days / 365
 * COMPOUND: base also includes interest already accrued (interest-on-interest)
 *           at the run cadence: base = outstanding + Σ prior accruals.
 *
 * Idempotent: the cursor advances to `asOf`, so re-running with the same `asOf`
 * posts nothing further.
 */
@Injectable()
export class InterestService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
  ) {}

  async accrueForBooking(companyId: string, bookingId: string, asOf?: Date): Promise<AccrualResult> {
    const now = asOf ?? this.clock.now();
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) => this.accrueInTx(tx, companyId, bookingId, now)),
    );
  }

  private async accrueInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    bookingId: string,
    asOf: Date,
  ): Promise<AccrualResult> {
    // Before any read: two runs for one booking (daily job, manual accrue, a
    // rule change's settle-up) must not both see "no prior accrual" and post
    // the same period twice.
    await lockBookingInterest(tx, bookingId);
    const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (!ACCRUING_STATUSES.includes(booking.status)) return { bookingId, postedPaise: 0n, installmentsAccrued: 0 };
    if (!booking.interestRuleId) return { bookingId, postedPaise: 0n, installmentsAccrued: 0 };

    const rule = await tx.interestRule.findFirst({ where: { id: booking.interestRuleId, companyId } });
    if (!rule) return { bookingId, postedPaise: 0n, installmentsAccrued: 0 };
    const rateBps = Math.round(Number(rule.ratePercent) * 100);
    const compound = rule.rateType === INTEREST_RATE_TYPE.COMPOUND;

    // `dueDate: { lt: asOf }` is also what makes an unraised STAGE_LINKED
    // installment (dueDate NULL) invisible to accrual: Postgres evaluates
    // `NULL < asOf` as NULL, which WHERE treats as false, so it never
    // enters this result set at all — see
    // docs/plans/construction-linked-demand-fix.md §2/§3. The non-null
    // assertion on inst.dueDate below is therefore always safe: every row
    // reaching this loop has already passed that filter.
    const installments = await tx.installment.findMany({
      where: { companyId, bookingId, isActive: true, dueDate: { lt: asOf } },
    });

    let postedPaise = 0n;
    let count = 0;

    for (const inst of installments) {
      const outstanding = inst.amountPaise - inst.allocatedPaise;
      if (outstanding <= 0n) continue;

      const priorAccruals = await tx.interestAccrual.findMany({
        where: { companyId, installmentId: inst.id },
        orderBy: { periodEnd: 'desc' },
      });
      const lastEnd: Date = priorAccruals.length > 0 ? priorAccruals[0].periodEnd : inst.dueDate!;
      // Interest runs only from the date the rule was attached (v0.9): a rule
      // attached late, or re-attached after a removal, charges nothing before it.
      const floor: Date | null = booking.interestFromDate;
      const cursor: Date = floor && toUtcMidnight(floor) > toUtcMidnight(lastEnd) ? floor : lastEnd;
      const days = daysBetween(cursor, asOf);
      if (days <= 0) continue;

      const accruedSoFar = priorAccruals.reduce((s: bigint, a: { accruedPaise: bigint }) => s + a.accruedPaise, 0n);
      const base = compound ? outstanding + accruedSoFar : outstanding;
      const delta = roundedDiv(base * BigInt(rateBps) * BigInt(days), 365n * 10_000n);
      if (delta <= 0n) continue;

      const [entry] = await this.ledger.post(tx, companyId, [
        {
          bookingId,
          entryType: LEDGER_ENTRY_TYPE.INTEREST,
          signedAmountPaise: delta,
          installmentId: inst.id,
          reason: `Delay interest (${rule.name})`,
          effectiveDate: asOf,
        },
      ]);
      await tx.interestAccrual.create({
        data: {
          companyId,
          bookingId,
          installmentId: inst.id,
          interestRuleId: rule.id,
          rateType: rule.rateType,
          ratePercentSnapshot: rule.ratePercent,
          periodStart: cursor,
          periodEnd: asOf,
          principalPaise: base,
          accruedPaise: delta,
          ledgerEntryId: entry.id,
        },
      });
      postedPaise += delta;
      count += 1;
    }

    return { bookingId, postedPaise, installmentsAccrued: count };
  }

  /** Accrue for every interest-bearing booking in one company (job body). */
  async accrueForCompany(companyId: string, asOf?: Date): Promise<AccrualResult[]> {
    const now = asOf ?? this.clock.now();
    const bookings = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.booking.findMany({
          where: { companyId, interestRuleId: { not: null }, status: { in: ACCRUING_STATUSES } },
          select: { id: true },
        }),
      ),
    );
    const results: AccrualResult[] = [];
    for (const b of bookings) {
      results.push(await this.accrueForBooking(companyId, b.id, now));
    }
    return results;
  }

  /** Waive accrued interest — an audited, permissioned credit (never edits accrual). */
  async waiveInterest(companyId: string, bookingId: string, dto: InterestWaiverDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');
        const [entry] = await this.ledger.post(tx, companyId, [
          {
            bookingId,
            entryType: LEDGER_ENTRY_TYPE.INTEREST_WAIVER,
            signedAmountPaise: -dto.amountPaise,
            reason: dto.reason,
            effectiveDate: dto.effectiveDate ?? this.clock.now(),
            createdById: actorId,
          },
        ]);
        return { ledgerEntryId: entry.id, waivedPaise: dto.amountPaise.toString() };
      }),
    );
  }
}
