import { Inject, Injectable } from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { maskPhone, normalizePhone } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';

/** Bookings that can take a receipt; the same set the post-sales reports call active. */
const ACTIVE_BOOKING_STATUSES = ['BOOKED', 'ALLOTTED', 'REGISTERED'] as const;

export interface ReceiptPayer {
  id: string;
  name: string;
  phoneMasked: string;
  bookings: Array<{ id: string; bookingNumber: string; unitLabel: string }>;
}

/**
 * Receipt Entry's payer lookup. Returns only people who are the primary or a
 * co-applicant on one of the company's active bookings, with a masked phone
 * and those bookings, so a receipt clerk can post a receipt without the
 * pre-sales applicant permissions (and without seeing leads).
 */
@Injectable()
export class ReceiptPayerService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  async search(companyId: string, search: string): Promise<ReceiptPayer[]> {
    const active = { companyId, status: { in: [...ACTIVE_BOOKING_STATUSES] } };
    const digits = normalizePhone(search).replace(/\D/g, '');
    const byNumber = { bookingNumber: { contains: search, mode: 'insensitive' } };
    const unit = { select: { number: true, floor: { select: { tower: { select: { name: true } } } } } };
    const bookingSelect = { select: { id: true, bookingNumber: true, unit } };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await runWithTenant({ companyId }, () => withTenantTx(this.tenantPrisma, companyId, (tx: any) => tx.applicant.findMany({
      where: {
        companyId,
        AND: [
          { OR: [{ primaryBookings: { some: active } }, { coApplicantOf: { some: { booking: active } } }] },
          {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              ...(digits.length >= 4 ? [{ primaryPhoneNormalized: { contains: digits } }] : []),
              { primaryBookings: { some: { ...active, ...byNumber } } },
              { coApplicantOf: { some: { booking: { ...active, ...byNumber } } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        primaryPhone: true,
        primaryBookings: { where: active, ...bookingSelect, orderBy: { bookingNumber: 'asc' } },
        coApplicantOf: { where: { booking: active }, select: { booking: bookingSelect } },
      },
      orderBy: { name: 'asc' },
      take: 10,
    })));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bookings = [...r.primaryBookings, ...r.coApplicantOf.map((c: any) => c.booking)].map((b: any) => ({
        id: b.id,
        bookingNumber: b.bookingNumber,
        unitLabel: b.unit.floor ? `${b.unit.floor.tower.name}/${b.unit.number}` : b.unit.number,
      }));
      return { id: r.id, name: r.name, phoneMasked: maskPhone(r.primaryPhone), bookings };
    });
  }
}
