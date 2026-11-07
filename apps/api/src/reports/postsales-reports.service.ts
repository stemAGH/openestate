import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { formatInr, computeAgeingBucket, AGEING_BUCKETS, type Clock } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';
import { CLOCK } from '../common/clock.provider';
import { LedgerService } from '../postsales/ledger.service';

export interface ReportScope {
  /**
   * `null` = admin-tier caller, no restriction. A finite array restricts
   * to bookings created by one of these user ids — the caller's own id
   * plus their full reporting subtree
   * (`TeamScopeService.getVisibleUserIds`).
   */
  visibleUserIds: string[] | null;
}

@Injectable()
export class PostsalesReportsService {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly ledger: LedgerService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bookingWhere(companyId: string, scope: ReportScope, projectId?: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (scope.visibleUserIds) where.createdById = { in: scope.visibleUserIds };
    // Unit.projectId (Phase A scalar) — the old floor.tower.projectId
    // traversal silently excluded every LAND_BASED booking from every
    // report that calls this shared helper. See
    // plotted-farmhouse-inventory.md §13.1.
    if (projectId) where.unit = { projectId };
    return where;
  }

  // ── Installment dues ────────────────────────────────────────

  async *installmentDues(companyId: string, scope: ReportScope, projectId?: string, withInterest = false) {
    const now = this.clock.now();
    const bookings = await this.systemPrisma.booking.findMany({
      where: { ...this.bookingWhere(companyId, scope, projectId), status: { in: ['BOOKED', 'ALLOTTED', 'REGISTERED'] } },
      select: { id: true, bookingNumber: true, primaryApplicant: { select: { name: true } } },
    });
    const bookingIds = bookings.map((b: { id: string }) => b.id);
    if (bookingIds.length === 0) return;

    // dueDate: { not: null } explicitly excludes unraised STAGE_LINKED
    // installments — without it, Postgres's default NULLS FIRST on an
    // ascending sort would put them at the very top of the dues list, and
    // .getTime() on a null dueDate below would throw. Nothing is "due" for
    // an unraised installment, so it must not appear in a dues report at
    // all. See internal plan construction-linked-demand-fix.md §2.
    const installments = await this.systemPrisma.installment.findMany({
      where: {
        companyId,
        bookingId: { in: bookingIds },
        isActive: true,
        status: { not: 'PAID' },
        dueDate: { not: null },
      },
      orderBy: { dueDate: 'asc' },
    });

    const byBooking = new Map(bookings.map((b: { id: string; bookingNumber: string; primaryApplicant: { name: string } }) => [b.id, b]));

    for (const inst of installments) {
      const outstanding = inst.amountPaise - inst.allocatedPaise;
      const overdueDays = Math.max(0, Math.floor((now.getTime() - inst.dueDate!.getTime()) / 86_400_000));
      const b = byBooking.get(inst.bookingId) as { bookingNumber: string; primaryApplicant: { name: string } };

      let interestFormatted = '';
      if (withInterest) {
        const accrued = await this.systemPrisma.interestAccrual.aggregate({
          where: { companyId, installmentId: inst.id },
          _sum: { accruedPaise: true },
        });
        interestFormatted = formatInr(accrued._sum.accruedPaise ?? 0n);
      }

      yield [
        b.bookingNumber,
        b.primaryApplicant.name,
        inst.label,
        inst.dueDate!.toISOString().slice(0, 10),
        formatInr(outstanding),
        String(overdueDays),
        ...(withInterest ? [interestFormatted] : []),
      ];
    }
  }

  // ── Collection ───────────────────────────────────────────────

  async *collectionDetail(companyId: string, scope: ReportScope, from?: Date, to?: Date, projectId?: string) {
    const bookingWhere = this.bookingWhere(companyId, scope, projectId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiptWhere: any = { companyId, isReversed: false, booking: bookingWhere };
    if (from || to) {
      receiptWhere.receiptDate = {};
      if (from) receiptWhere.receiptDate.gte = from;
      if (to) receiptWhere.receiptDate.lte = to;
    }

    const receipts = await this.systemPrisma.receipt.findMany({
      where: receiptWhere,
      include: { booking: { include: { primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } } } } },
      orderBy: { receiptDate: 'asc' },
    });

    for (const r of receipts) {
      yield [
        r.receiptNumber,
        r.receiptDate.toISOString().slice(0, 10),
        r.booking.bookingNumber,
        r.booking.primaryApplicant.name,
        r.mode,
        formatInr(r.grossAmountPaise),
      ];
    }
  }

  async collectionSummary(companyId: string, scope: ReportScope, from?: Date, to?: Date, projectId?: string) {
    const bookingWhere = this.bookingWhere(companyId, scope, projectId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiptWhere: any = { companyId, isReversed: false, booking: bookingWhere };
    if (from || to) {
      receiptWhere.receiptDate = {};
      if (from) receiptWhere.receiptDate.gte = from;
      if (to) receiptWhere.receiptDate.lte = to;
    }
    const agg = await this.systemPrisma.receipt.aggregate({
      where: receiptWhere,
      _sum: { grossAmountPaise: true },
      _count: true,
    });
    return {
      totalReceipts: agg._count,
      totalCollectedFormatted: formatInr(agg._sum.grossAmountPaise ?? 0n),
    };
  }

  async *collectionByPeriod(
    companyId: string,
    scope: ReportScope,
    granularity: 'daily' | 'monthly',
    from?: Date,
    to?: Date,
    projectId?: string,
  ) {
    const bookingWhere = this.bookingWhere(companyId, scope, projectId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiptWhere: any = { companyId, isReversed: false, booking: bookingWhere };
    if (from || to) {
      receiptWhere.receiptDate = {};
      if (from) receiptWhere.receiptDate.gte = from;
      if (to) receiptWhere.receiptDate.lte = to;
    }
    const receipts = await this.systemPrisma.receipt.findMany({
      where: receiptWhere,
      select: { receiptDate: true, grossAmountPaise: true },
      orderBy: { receiptDate: 'asc' },
    });

    const buckets = new Map<string, bigint>();
    for (const r of receipts) {
      const key =
        granularity === 'daily'
          ? r.receiptDate.toISOString().slice(0, 10)
          : r.receiptDate.toISOString().slice(0, 7);
      buckets.set(key, (buckets.get(key) ?? 0n) + r.grossAmountPaise);
    }
    for (const [period, total] of [...buckets.entries()].sort()) {
      yield [period, formatInr(total)];
    }
  }

  // ── Applicant ledger (reconciles exactly to LedgerService.balance()) ──

  async applicantLedger(companyId: string, bookingId: string, scope: ReportScope) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id: bookingId, ...this.bookingWhere(companyId, scope) },
      include: { primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found or not in scope');

    const entries = await this.systemPrisma.ledgerEntry.findMany({
      where: { companyId, bookingId },
      orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
    });

    let running = 0n;
    const rows = entries.map((e: { id: string; entryType: string; signedAmountPaise: bigint; effectiveDate: Date; reason: string | null }) => {
      running += e.signedAmountPaise;
      return {
        id: e.id,
        entryType: e.entryType,
        effectiveDate: e.effectiveDate.toISOString().slice(0, 10),
        reason: e.reason,
        signedAmountPaise: e.signedAmountPaise.toString(),
        runningBalancePaise: running.toString(),
      };
    });

    return {
      bookingId,
      bookingNumber: booking.bookingNumber,
      applicantName: booking.primaryApplicant.name,
      entries: rows,
      balancePaise: running.toString(),
    };
  }

  // ── Inventory rollups (company/project-wide, not owned by an individual) ──

  async unitStatusRollup(companyId: string, projectId?: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    // Unit.projectId (Phase A scalar) — see plotted-farmhouse-inventory.md
    // §13.1. Direct field here since this queries Unit itself, not
    // through a booking's unit relation.
    if (projectId) where.projectId = projectId;
    const rows = await this.systemPrisma.unit.groupBy({ by: ['status'], where, _count: { _all: true } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ status: r.status, count: r._count._all }));
  }

  async bookingStatusRollup(companyId: string, projectId?: string) {
    // Reuses bookingWhere() rather than re-deriving the same projectId
    // traversal a second time — this file's own history is exactly one
    // instance of that duplication silently going stale (§13.1).
    const where = this.bookingWhere(companyId, { visibleUserIds: null }, projectId);
    const rows = await this.systemPrisma.booking.groupBy({ by: ['status'], where, _count: { _all: true } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ status: r.status, count: r._count._all }));
  }

  async projectRollup(companyId: string) {
    const projects = await this.systemPrisma.project.findMany({ where: { companyId }, select: { id: true, name: true } });
    const out: Array<{ projectId: string; projectName: string; totalUnits: number; bookedOrBeyond: number; collectedFormatted: string }> = [];
    for (const p of projects) {
      // Unit.projectId (Phase A scalar) throughout — the old
      // floor.tower.projectId traversal silently zeroed every one of
      // these three figures for a LAND_BASED project. See
      // plotted-farmhouse-inventory.md §13.1.
      const totalUnits = await this.systemPrisma.unit.count({ where: { companyId, projectId: p.id } });
      const bookedOrBeyond = await this.systemPrisma.unit.count({
        where: { companyId, projectId: p.id, status: { in: ['BOOKED', 'ALLOTTED', 'REGISTERED'] } },
      });
      const receiptAgg = await this.systemPrisma.receipt.aggregate({
        where: { companyId, isReversed: false, booking: { unit: { projectId: p.id } } },
        _sum: { grossAmountPaise: true },
      });
      out.push({
        projectId: p.id,
        projectName: p.name,
        totalUnits,
        bookedOrBeyond,
        collectedFormatted: formatInr(receiptAgg._sum.grossAmountPaise ?? 0n),
      });
    }
    return out;
  }

  async companyRollup(companyId: string) {
    const [totalUnits, sold, receiptAgg] = await Promise.all([
      this.systemPrisma.unit.count({ where: { companyId } }),
      this.systemPrisma.unit.count({ where: { companyId, status: { in: ['BOOKED', 'ALLOTTED', 'REGISTERED'] } } }),
      this.systemPrisma.receipt.aggregate({ where: { companyId, isReversed: false }, _sum: { grossAmountPaise: true } }),
    ]);
    return {
      totalUnits,
      soldOrBeyond: sold,
      availableOrHeld: totalUnits - sold,
      totalCollectedFormatted: formatInr(receiptAgg._sum.grossAmountPaise ?? 0n),
    };
  }

  // ── GST-rate configuration gap: bookings priced before the base-line
  // rate picker existed, so their BASE line has no gstRateId ──────────

  /**
   * The base-line rate picker (BookingService.createBooking) stops this
   * from happening for new bookings, but does not retroactively touch
   * bookings created before it existed — BookingCostLine is an immutable
   * snapshot, and there is no way to know after the fact what the
   * correct historical rate should have been without a human reviewing
   * each one (same reasoning as the CompanyConfig gstStateCode gap).
   * This surfaces the count cheaply (indexed count, no row
   * materialization) so an admin finds out from the app, not from a
   * customer holding a demand letter with ₹0 GST on it.
   */
  async zeroGstBaseBookingsCount(companyId: string): Promise<number> {
    return this.systemPrisma.bookingCostLine.count({
      where: { companyId, kind: 'BASE', gstRateId: null },
    });
  }

  async *zeroGstBaseBookings(companyId: string) {
    const lines = await this.systemPrisma.bookingCostLine.findMany({
      where: { companyId, kind: 'BASE', gstRateId: null },
      select: {
        booking: {
          select: {
            bookingNumber: true,
            bookingDate: true,
            primaryApplicant: { select: { name: true } },
            unit: { select: { number: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const l of lines) {
      const b = l.booking;
      yield [
        b.bookingNumber,
        b.primaryApplicant.name,
        b.unit.number,
        b.bookingDate.toISOString().slice(0, 10),
      ];
    }
  }

  // ── Ageing (reuses the Phase 3 ageing-bucket helper) ────────

  async duesAgeing(companyId: string, scope: ReportScope, projectId?: string) {
    const now = this.clock.now();
    const bookings = await this.systemPrisma.booking.findMany({
      where: { ...this.bookingWhere(companyId, scope, projectId), status: { in: ['BOOKED', 'ALLOTTED', 'REGISTERED'] } },
      select: { id: true },
    });
    const bookingIds = bookings.map((b: { id: string }) => b.id);
    if (bookingIds.length === 0) {
      return AGEING_BUCKETS.map((bucket) => ({ bucket, count: 0 }));
    }

    // dueDate: { lt: now } already excludes unraised installments via
    // Postgres NULL-comparison semantics (NULL < now is NULL, not true) —
    // no separate `not: null` needed here, unlike installmentDues() above
    // whose query had no date filter at all. Confirmed by an explicit
    // regression test, not just this comment. See
    // internal plan construction-linked-demand-fix.md §2.
    const overdue = await this.systemPrisma.installment.findMany({
      where: { companyId, bookingId: { in: bookingIds }, isActive: true, status: { not: 'PAID' }, dueDate: { lt: now } },
      select: { dueDate: true },
    });

    const counts = new Map<string, number>(AGEING_BUCKETS.map((b) => [b, 0]));
    for (const inst of overdue) {
      const bucket = computeAgeingBucket(inst.dueDate!, now);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return AGEING_BUCKETS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
  }

  // ── Birthday list ────────────────────────────────────────────

  async *birthdayList(companyId: string, withinDays: number) {
    const now = this.clock.now();
    const applicants = await this.systemPrisma.applicant.findMany({
      where: { companyId, mergedIntoId: null, dateOfBirth: { not: null } },
      select: { name: true, primaryPhone: true, dateOfBirth: true },
    });

    for (const a of applicants) {
      if (!a.dateOfBirth) continue; // excluded by the where clause; guard satisfies TS
      const dob = a.dateOfBirth;
      const nextBirthday = new Date(now.getFullYear(), dob.getUTCMonth(), dob.getUTCDate());
      if (nextBirthday < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        nextBirthday.setFullYear(now.getFullYear() + 1);
      }
      const daysAway = Math.round((nextBirthday.getTime() - now.getTime()) / 86_400_000);
      if (daysAway <= withinDays) {
        yield [a.name, a.primaryPhone, dob.toISOString().slice(5, 10), String(daysAway)];
      }
    }
  }
}
