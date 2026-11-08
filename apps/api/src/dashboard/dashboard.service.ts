import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { istDayBounds, type Clock } from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';
import { ReportsService } from '../presales/reports.service';
import { TeamScopeService } from '../team-scope/team-scope.service';

// Explicitly a literal-union array, not `string[]`: Prisma's `groupBy`
// types `status.in` as `InquiryStatus[]` and rejects a widened `string[]`
// (`count` is laxer, which is why only the groupBy calls failed).
const OPEN_STATUSES: Array<'OPEN' | 'CONTINUED'> = ['OPEN', 'CONTINUED'];

export interface DashboardSummary {
  followUpsToday: number;
  followUpsOverdue: number;
  openInquiries: number;
  conversionsThisMonth: number;
  byStatus: Array<{ status: string; count: number }>;
}

export interface DashboardReportRow {
  userId: string;
  name: string;
  roleName: string | null;
  openInquiries: number;
  followUpsToday: number;
  followUpsOverdue: number;
  conversionsThisMonth: number;
  /** Latest follow-up this user logged — the "is this person active" signal. */
  lastActivityAt: Date | null;
}

export interface DashboardResponse {
  mine: DashboardSummary;
  team:
    | (DashboardSummary & { memberCount: number; perReport: DashboardReportRow[] })
    | null;
  generatedAt: Date;
}

/**
 * The staff dashboard's data source. Deliberately its OWN endpoint rather
 * than the frontend calling `/reports/presales/*`, for two concrete
 * reasons found by reading the permission sets rather than assumed:
 *
 * 1. `sales_executive` does not hold `PRESALES_REPORT_VIEW` (see
 *    ROLE_PERMISSIONS — its presales grants are enumerated individually,
 *    not the `presales.*` wildcard `sales_manager` gets). A rep calling
 *    the reports endpoints for their own dashboard would 403 on their own
 *    home screen. This endpoint is gated on `PRESALES_INQUIRY_READ`
 *    instead — if you can see inquiries, you can see your own summary of
 *    them.
 * 2. The reports endpoints take exactly one scope (the caller's full
 *    visible set). The dashboard needs "mine" and "my whole team" side by
 *    side, which no existing endpoint can express.
 *
 * What IS reused rather than reimplemented: `ReportsService.funnelByStatus`,
 * called once per scope for the status breakdown. `staffPerformance` was
 * considered for the per-report table and rejected — it is all-time
 * (totalAssigned/successful/conversion%), and mixing all-time columns with
 * this-month columns in one table reads as a single period and isn't.
 * Everything else here (follow-ups due today/overdue, month-bounded
 * conversions, last-activity) is new aggregation because nothing existing
 * computes it at all.
 *
 * `conversionsThisMonth` keys off `Inquiry.convertedAt`, stamped by
 * InquiryService.update() on the transition into SUCCESSFUL and cleared
 * when an inquiry moves back out. It deliberately does NOT use
 * `updatedAt`, which an earlier version did: every unrelated edit bumps
 * that, so editing a lead closed months ago silently re-dated it into the
 * current month and moved a manager's team-performance number. Inquiries
 * closed before that column existed were backfilled from `updatedAt` —
 * the same approximation the old figure already used, so no historical
 * number changed, they merely stopped drifting (see CHANGELOG.md).
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly reportsService: ReportsService,
    private readonly teamScope: TeamScopeService,
  ) {}

  /** `null` userIds = no owner filter (admin-tier: the whole company). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ownerWhere(companyId: string, userIds: string[] | null): any {
    return userIds ? { companyId, assignedToId: { in: userIds } } : { companyId };
  }

  private bounds() {
    const now = this.clock.now();
    // "Due today" / "overdue" use the IST calendar day, so these tiles
    // match the inquiry list's followUp filter and its labels.
    const { startOfToday, endOfToday } = istDayBounds(now);
    // ponytail: the month is still the host's local month; move it to IST
    // with the conversions report if a UTC host shows month-edge drift.
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { now, startOfToday, endOfToday, startOfMonth };
  }

  private async summaryFor(
    companyId: string,
    userIds: string[] | null,
  ): Promise<DashboardSummary> {
    const { startOfToday, endOfToday, startOfMonth } = this.bounds();
    const base = this.ownerWhere(companyId, userIds);

    const [followUpsToday, followUpsOverdue, openInquiries, conversionsThisMonth, byStatus] =
      await Promise.all([
        this.systemPrisma.inquiry.count({
          where: {
            ...base,
            status: { in: OPEN_STATUSES },
            nextFollowupAt: { gte: startOfToday, lte: endOfToday },
          },
        }),
        this.systemPrisma.inquiry.count({
          where: {
            ...base,
            status: { in: OPEN_STATUSES },
            nextFollowupAt: { lt: startOfToday },
          },
        }),
        this.systemPrisma.inquiry.count({
          where: { ...base, status: { in: OPEN_STATUSES } },
        }),
        this.systemPrisma.inquiry.count({
          where: { ...base, convertedAt: { gte: startOfMonth } },
        }),
        this.reportsService.funnelByStatus(companyId, { visibleUserIds: userIds }, {}),
      ]);

    return { followUpsToday, followUpsOverdue, openInquiries, conversionsThisMonth, byStatus };
  }

  /**
   * One grouped query per metric across the WHOLE team, not N queries per
   * member — a 30-person team costs the same 5 round trips as a 3-person one.
   */
  private async perReportRows(
    companyId: string,
    memberIds: string[],
  ): Promise<DashboardReportRow[]> {
    if (memberIds.length === 0) return [];
    const { startOfToday, endOfToday, startOfMonth } = this.bounds();
    const inTeam = { companyId, assignedToId: { in: memberIds } };

    const [members, openRows, todayRows, overdueRows, convertedRows, activityRows] =
      await Promise.all([
        this.systemPrisma.user.findMany({
          where: { id: { in: memberIds }, companyId },
          select: { id: true, name: true, role: { select: { name: true } } },
          orderBy: { name: 'asc' },
        }),
        this.systemPrisma.inquiry.groupBy({
          by: ['assignedToId'],
          where: { ...inTeam, status: { in: OPEN_STATUSES } },
          _count: { _all: true },
        }),
        this.systemPrisma.inquiry.groupBy({
          by: ['assignedToId'],
          where: {
            ...inTeam,
            status: { in: OPEN_STATUSES },
            nextFollowupAt: { gte: startOfToday, lte: endOfToday },
          },
          _count: { _all: true },
        }),
        this.systemPrisma.inquiry.groupBy({
          by: ['assignedToId'],
          where: {
            ...inTeam,
            status: { in: OPEN_STATUSES },
            nextFollowupAt: { lt: startOfToday },
          },
          _count: { _all: true },
        }),
        this.systemPrisma.inquiry.groupBy({
          by: ['assignedToId'],
          where: { ...inTeam, convertedAt: { gte: startOfMonth } },
          _count: { _all: true },
        }),
        this.systemPrisma.followUp.groupBy({
          by: ['createdById'],
          where: { companyId, createdById: { in: memberIds } },
          _max: { createdAt: true },
        }),
      ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countBy = (rows: any[]) =>
      new Map<string, number>(
        rows
          .filter((r) => r.assignedToId)
          .map((r) => [r.assignedToId as string, r._count._all as number]),
      );

    const open = countBy(openRows);
    const today = countBy(todayRows);
    const overdue = countBy(overdueRows);
    const converted = countBy(convertedRows);
    const lastActivity = new Map<string, Date | null>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (activityRows as any[])
        .filter((r) => r.createdById)
        .map((r) => [r.createdById as string, (r._max?.createdAt ?? null) as Date | null]),
    );

    return members.map(
      (m: { id: string; name: string; role: { name: string } | null }) => ({
        userId: m.id,
        name: m.name,
        roleName: m.role?.name ?? null,
        openInquiries: open.get(m.id) ?? 0,
        followUpsToday: today.get(m.id) ?? 0,
        followUpsOverdue: overdue.get(m.id) ?? 0,
        conversionsThisMonth: converted.get(m.id) ?? 0,
        lastActivityAt: lastActivity.get(m.id) ?? null,
      }),
    );
  }

  async getDashboard(
    companyId: string,
    userId: string,
    permissions: readonly string[],
  ): Promise<DashboardResponse> {
    const visibleUserIds = await this.teamScope.getVisibleUserIds(companyId, userId, permissions);

    // "Mine" is always exactly the caller, never the visible set — a
    // manager's own queue is a different number from their team's, and
    // conflating them is the whole reason this needs two scopes.
    const mine = await this.summaryFor(companyId, [userId]);

    // Admin-tier (visibleUserIds === null) sees the whole company as their
    // "team". Everyone else has a team only if the subtree contains
    // somebody other than themselves.
    const hasTeam = visibleUserIds === null || visibleUserIds.length > 1;
    if (!hasTeam) {
      return { mine, team: null, generatedAt: this.clock.now() };
    }

    const memberIds =
      visibleUserIds === null
        ? (
            await this.systemPrisma.user.findMany({
              where: { companyId, isActive: true },
              select: { id: true },
            })
          ).map((u: { id: string }) => u.id)
        : visibleUserIds;

    const [teamSummary, perReport] = await Promise.all([
      this.summaryFor(companyId, visibleUserIds),
      // The caller is excluded from their own per-report breakdown — the
      // table answers "how are my people doing", and their own figures are
      // already the `mine` block directly above it.
      this.perReportRows(
        companyId,
        memberIds.filter((id) => id !== userId),
      ),
    ]);

    return {
      mine,
      team: { ...teamSummary, memberCount: memberIds.length, perReport },
      generatedAt: this.clock.now(),
    };
  }
}
