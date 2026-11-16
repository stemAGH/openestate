import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  COMMISSION_PAYMENT_STATUS,
  COMMISSION_ENTRY_TYPE,
  NOTIFICATION_EVENT,
  formatInr,
  percentOf,
  allocate,
  type RequestCommissionPaymentDto,
  type PayCommissionPaymentDto,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import { CommissionService } from './commission.service';
import { NotificationService } from '../notifications/notification.service';

/**
 * REQUESTED -> APPROVED -> PAID | REJECTED, mirroring RefundStatus's shape
 * (apps/api/src/postsales/refund.service.ts, frozen — used only as a
 * design template, never imported). Ledger entries post ONLY at pay() —
 * deliberately unlike RefundService (which posts its ledger entry at
 * approve() and only records a PaymentVoucher at pay()) — because a
 * refund's obligation is newly-recognized at approval, while a broker's
 * commission was already accrued earlier (CommissionService.accrueForBooking).
 * request()/approve() here are pure dispute/authorization sign-off with no
 * ledger effect; the ledger only moves when cash actually leaves at pay(),
 * which is also the only point TDS is computed and withheld.
 *
 * TDS-194H asymmetry with 194-IA (ReceiptService, frozen, not touched):
 * for 194-IA the COMPANY IS THE DEDUCTEE — a buyer withholds tax FROM the
 * company, so the company is owed a certificate (Form 16B) before it can
 * claim credit, hence ReceiptService posts a TDS_RECEIVABLE that stays
 * outstanding until a TdsCertificate zeroes it via TDS_CERT_ADJUSTMENT.
 * For 194-H the COMPANY IS THE DEDUCTOR — it withholds tax FROM THE
 * BROKER and later files its own TDS return and issues Form 16A TO the
 * broker; from the broker's ledger (what CommissionLedgerEntry tracks),
 * there is nothing to receive or certify. The moment pay() runs, gross
 * minus TDS is a completed, known fact — TDS_WITHHELD is final, not a
 * receivable. See CLAUDE.md's Phase 5 Decisions log for the same
 * paragraph, cross-referenced from the 194-IA side too.
 */
@Injectable()
export class CommissionPaymentService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly commission: CommissionService,
    private readonly notifications: NotificationService,
  ) {}

  async history(companyId: string, brokerId: string) {
    return this.systemPrisma.commissionPayment.findMany({
      where: { companyId, brokerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async request(companyId: string, dto: RequestCommissionPaymentDto, actorId: string | null) {
    const broker = await this.systemPrisma.broker.findFirst({ where: { id: dto.brokerId, companyId } });
    if (!broker) throw new NotFoundException('Broker not found');

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const outstanding = await this.commission.balanceInTx(tx, companyId, dto.brokerId);
        if (dto.amountPaise > outstanding) {
          throw new BadRequestException(
            `Requested amount (${dto.amountPaise}) exceeds the broker's outstanding commission (${outstanding})`,
          );
        }

        return tx.commissionPayment.create({
          data: {
            companyId,
            brokerId: dto.brokerId,
            amountPaise: dto.amountPaise,
            status: COMMISSION_PAYMENT_STATUS.REQUESTED,
            createdById: actorId,
          },
        });
      }),
    );
  }

  async approve(companyId: string, paymentId: string, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const payment = await tx.commissionPayment.findFirst({ where: { id: paymentId, companyId } });
        if (!payment) throw new NotFoundException('Commission payment not found');
        if (payment.status !== COMMISSION_PAYMENT_STATUS.REQUESTED) {
          throw new ConflictException(`Commission payment is ${payment.status}; only REQUESTED can be approved`);
        }
        return tx.commissionPayment.update({
          where: { id: paymentId },
          data: { status: COMMISSION_PAYMENT_STATUS.APPROVED, approvedById: actorId, approvedAt: new Date() },
        });
      }),
    );
  }

  async reject(companyId: string, paymentId: string, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const payment = await tx.commissionPayment.findFirst({ where: { id: paymentId, companyId } });
        if (!payment) throw new NotFoundException('Commission payment not found');
        if (payment.status !== COMMISSION_PAYMENT_STATUS.REQUESTED) {
          throw new ConflictException(`Commission payment is ${payment.status}; only REQUESTED can be rejected`);
        }
        return tx.commissionPayment.update({
          where: { id: paymentId },
          data: { status: COMMISSION_PAYMENT_STATUS.REJECTED, approvedById: actorId, approvedAt: new Date() },
        });
      }),
    );
  }

  /**
   * The only step that touches the ledger — see the class doc comment for
   * why. A broker is typically paid periodically across several bookings
   * at once, so the gross payment is allocated oldest-outstanding-booking-
   * first (same idea as the receipt-entry UI's oldest-dues-first
   * allocation), then TDS is computed ONCE on the total gross and split
   * proportionally across those per-booking allocations via `allocate`
   * (largest-remainder — no last-paise loss), so each affected booking
   * gets its own PAYMENT + TDS_WITHHELD pair. This is what makes
   * handleBookingCancelled's PER-BOOKING outstanding calculation correct
   * for a broker paid across multiple bookings in one CommissionPayment.
   */
  async pay(companyId: string, paymentId: string, dto: PayCommissionPaymentDto, actorId: string | null) {
    const paid = await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const payment = await tx.commissionPayment.findFirst({ where: { id: paymentId, companyId } });
        if (!payment) throw new NotFoundException('Commission payment not found');
        if (payment.status !== COMMISSION_PAYMENT_STATUS.APPROVED) {
          throw new ConflictException(`Commission payment is ${payment.status}; only APPROVED can be paid`);
        }
        await assertOwnedByCompany(tx, companyId, [['bank', dto.bankId, 'Bank']]);

        // Per-booking outstanding for this broker, oldest-first-seen.
        const allEntries: { bookingId: string; signedAmountPaise: bigint; createdAt: Date }[] =
          await tx.commissionLedgerEntry.findMany({
            where: { companyId, brokerId: payment.brokerId },
            orderBy: { createdAt: 'asc' },
          });
        const byBooking = new Map<string, { total: bigint; firstSeen: Date }>();
        for (const e of allEntries) {
          const cur = byBooking.get(e.bookingId) ?? { total: 0n, firstSeen: e.createdAt };
          cur.total += e.signedAmountPaise;
          byBooking.set(e.bookingId, cur);
        }
        const outstandingBookings = [...byBooking.entries()]
          .filter(([, v]) => v.total > 0n)
          .sort((a, b) => a[1].firstSeen.getTime() - b[1].firstSeen.getTime());

        let remaining = payment.amountPaise;
        const grossAllocations: { bookingId: string; grossPaise: bigint }[] = [];
        for (const [bookingId, v] of outstandingBookings) {
          if (remaining <= 0n) break;
          const take = v.total < remaining ? v.total : remaining;
          grossAllocations.push({ bookingId, grossPaise: take });
          remaining -= take;
        }
        if (grossAllocations.length === 0) {
          throw new BadRequestException('No outstanding commission found for this broker to attribute the payment to');
        }
        if (remaining > 0n) {
          throw new BadRequestException(
            `Payment amount (${payment.amountPaise}) exceeds the broker's total outstanding across bookings`,
          );
        }

        // 194-H TDS is server-computed from the rate (the company is the
        // deductor and controls the payment) — unlike 194-IA's
        // client-supplied deduction on the customer side, where the buyer
        // withholds and self-reports what they withheld.
        let tdsPaise = 0n;
        const rule = await tx.tdsRule.findFirst({
          where: {
            companyId,
            section: '194-H',
            effectiveFrom: { lte: dto.paymentDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: dto.paymentDate } }],
          },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (rule && payment.amountPaise >= rule.thresholdPaise) {
          tdsPaise = percentOf(payment.amountPaise, Math.round(Number(rule.ratePercent) * 100));
        }
        const tdsShares = tdsPaise > 0n ? allocate(tdsPaise, grossAllocations.map((a) => a.grossPaise)) : grossAllocations.map(() => 0n);

        for (let i = 0; i < grossAllocations.length; i++) {
          const { bookingId, grossPaise } = grossAllocations[i];
          const tdsShare = tdsShares[i];
          await tx.commissionLedgerEntry.create({
            data: {
              companyId,
              brokerId: payment.brokerId,
              bookingId,
              entryType: COMMISSION_ENTRY_TYPE.PAYMENT,
              signedAmountPaise: -(grossPaise - tdsShare),
              reason: `Commission payment ${paymentId}`,
              effectiveDate: dto.paymentDate,
              createdById: actorId,
            },
          });
          if (tdsShare > 0n) {
            await tx.commissionLedgerEntry.create({
              data: {
                companyId,
                brokerId: payment.brokerId,
                bookingId,
                entryType: COMMISSION_ENTRY_TYPE.TDS_WITHHELD,
                signedAmountPaise: -tdsShare,
                reason: `194-H TDS withheld on commission payment ${paymentId}`,
                effectiveDate: dto.paymentDate,
                createdById: actorId,
              },
            });
          }
        }

        return tx.commissionPayment.update({
          where: { id: paymentId },
          data: {
            status: COMMISSION_PAYMENT_STATUS.PAID,
            mode: dto.mode,
            bankId: dto.bankId ?? null,
            instrumentNumber: dto.instrumentNumber ?? null,
            paidAt: dto.paymentDate,
          },
        });
      }),
    );

    // Fired AFTER the transaction commits (CLAUDE.md Phase 1 rule).
    await this.notifications.notify(
      companyId,
      NOTIFICATION_EVENT.COMMISSION_PAID,
      { brokerId: paid.brokerId },
      'Commission payment processed',
      `A commission payment of ${formatInr(paid.amountPaise)} has been processed.`,
    );

    return paid;
  }
}
