import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { maskPhone, normalizePhone, PERMISSIONS } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';

export interface BookingListQuery {
  page: number;
  limit: number;
  search?: string;
  status?: string;
  projectId?: string;
  towerId?: string;
  from?: Date;
  to?: Date;
  sortBy?: 'bookingNumber' | 'bookingDate' | 'status';
  sortOrder: 'asc' | 'desc';
}

/**
 * The bookings list: one page of bookings with the applicant (phone masked),
 * unit, project and the ledger balance (one grouped query per page). Scope is
 * decided by the caller: `visibleUserIds` null for the whole company,
 * otherwise bookings created by those users (the post-sales report rule).
 * Every query filters by company.
 */
@Injectable()
export class BookingListService {
  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient) {}

  async list(companyId: string, q: BookingListQuery, visibleUserIds: string[] | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const and: any[] = [];
    if (visibleUserIds) and.push({ createdById: { in: visibleUserIds } });
    if (q.status) and.push({ status: q.status });
    if (q.projectId) and.push({ unit: { projectId: q.projectId } });
    if (q.towerId) and.push({ unit: { floor: { towerId: q.towerId } } });
    if (q.from || q.to) and.push({ bookingDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } });
    if (q.search) {
      const digits = normalizePhone(q.search).replace(/\D/g, '');
      and.push({
        OR: [
          { bookingNumber: { contains: q.search, mode: 'insensitive' } },
          { primaryApplicant: { name: { contains: q.search, mode: 'insensitive' } } },
          ...(digits.length >= 4 ? [{ primaryApplicant: { primaryPhoneNormalized: { contains: digits } } }] : []),
        ],
      });
    }
    const where = { companyId, AND: and };
    const [rows, total] = await Promise.all([
      this.systemPrisma.booking.findMany({
        where,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: q.sortBy ? { [q.sortBy]: q.sortOrder } : { bookingDate: 'desc' },
        select: {
          id: true,
          bookingNumber: true,
          status: true,
          bookingDate: true,
          agreedPricePaise: true,
          primaryApplicant: { select: { id: true, name: true, primaryPhone: true } },
          unit: {
            select: {
              number: true,
              project: { select: { id: true, name: true } },
              floor: { select: { tower: { select: { name: true } } } },
            },
          },
        },
      }),
      this.systemPrisma.booking.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const sums = ids.length
      ? await this.systemPrisma.ledgerEntry.groupBy({ by: ['bookingId'], where: { companyId, bookingId: { in: ids } }, _sum: { signedAmountPaise: true } })
      : [];
    const balance = new Map(sums.map((s) => [s.bookingId, s._sum.signedAmountPaise ?? 0n]));
    return {
      data: rows.map((r) => ({
        id: r.id,
        bookingNumber: r.bookingNumber,
        status: r.status,
        bookingDate: r.bookingDate,
        agreedPricePaise: r.agreedPricePaise.toString(),
        // Positive: the customer owes this much; negative: owed back to them.
        balancePaise: (balance.get(r.id) ?? 0n).toString(),
        applicant: { id: r.primaryApplicant.id, name: r.primaryApplicant.name, primaryPhone: maskPhone(r.primaryApplicant.primaryPhone) },
        unit: { label: r.unit.floor ? `${r.unit.floor.tower.name}/${r.unit.number}` : r.unit.number },
        project: r.unit.project,
      })),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }
}

/**
 * Who created the bookings a caller may see or edit: null for the whole
 * company (reports.postsales.company-wide, or admin.team-scope.all through
 * TeamScopeService), otherwise the caller and their reports.
 */
export async function bookingScope(
  teamScope: { getVisibleUserIds: (companyId: string, userId: string, permissions: string[]) => Promise<string[] | null> },
  u: { companyId: string; sub: string; permissions: string[] },
): Promise<string[] | null> {
  if (u.permissions.includes(PERMISSIONS.REPORTS_POSTSALES_COMPANY_WIDE)) return null;
  return teamScope.getVisibleUserIds(u.companyId, u.sub, u.permissions);
}
