import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import {
  formatInr,
  LEDGER_ENTRY_TYPE,
  REFUND_STATUS,
  VOUCHER_STATUS_ISSUED,
  type RequestRefundDto,
  type PayRefundDto,
} from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import { LedgerService } from './ledger.service';

/**
 * Two-phase refund (see CLAUDE.md Phase 4 decisions):
 *  - APPROVED posts a REFUND_APPROVED debit — the obligation is recognised in
 *    the customer sub-ledger at approval, moving the balance toward zero.
 *  - PAID records a PaymentVoucher (actual cash OUTFLOW). It posts NO further
 *    ledger entry — that would double-count the obligation already recognised
 *    at approval. The sub-ledger tracks obligations; the voucher tracks
 *    settlement.
 *  - A refund cheque that bounces re-opens the obligation with a
 *    REFUND_BOUNCE_REVERSAL credit + a BOUNCE_CHARGE debit — exactly like a
 *    receipt cheque bounce.
 *  - The refundable cap (QA-015) holds at request, approval and payment, under a
 *    per-booking advisory lock taken before the check, so two refunds for the
 *    same money can't both pass.
 */
@Injectable()
export class RefundService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly ledger: LedgerService,
  ) {}

  async request(companyId: string, bookingId: string, dto: RequestRefundDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');
        await lockBookingRefunds(tx, bookingId);

        const balance = await this.ledger.balanceInTx(tx, companyId, bookingId);
        const owedToCustomer = balance < 0n ? -balance : 0n;
        // Approved refunds are already in the ledger; requested ones are not.
        const open = await tx.refund.aggregate({
          where: { companyId, bookingId, status: REFUND_STATUS.REQUESTED },
          _sum: { amountPaise: true },
        });
        const requested: bigint = open._sum.amountPaise ?? 0n;
        const available = owedToCustomer > requested ? owedToCustomer - requested : 0n;
        if (dto.amountPaise > available) {
          throw new BadRequestException(
            `Refund (${dto.amountPaise}) exceeds the amount still refundable (${available}): owed to the customer ${owedToCustomer}, already requested ${requested}`,
          );
        }

        return tx.refund.create({
          data: {
            companyId,
            bookingId,
            amountPaise: dto.amountPaise,
            mode: dto.mode ?? null,
            status: REFUND_STATUS.REQUESTED,
            createdById: actorId,
          },
        });
      }),
    );
  }

  async approve(companyId: string, refundId: string, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const found = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!found) throw new NotFoundException('Refund not found');
        await lockBookingRefunds(tx, found.bookingId);
        // Read again under the lock: a concurrent decision may have just committed.
        const refund = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== REFUND_STATUS.REQUESTED) {
          throw new ConflictException(`Refund is ${refund.status}; only REQUESTED can be approved`);
        }
        const balance = await this.ledger.balanceInTx(tx, companyId, refund.bookingId);
        const owedToCustomer = balance < 0n ? -balance : 0n;
        if (refund.amountPaise > owedToCustomer) {
          throw new BadRequestException(
            `Refund of ${formatInr(refund.amountPaise)} exceeds the amount owed to the customer now, ${formatInr(owedToCustomer)}. ` +
              'Less may be owed than when it was requested (for example after a bounce charge): reject this refund and request the correct amount.',
          );
        }

        await this.ledger.post(tx, companyId, [
          {
            bookingId: refund.bookingId,
            entryType: LEDGER_ENTRY_TYPE.REFUND_APPROVED,
            signedAmountPaise: refund.amountPaise, // debit: discharges the obligation in the sub-ledger
            reason: 'Refund approved',
            effectiveDate: new Date(),
            createdById: actorId,
          },
        ]);

        return tx.refund.update({
          where: { id: refundId },
          data: { status: REFUND_STATUS.APPROVED, approvedById: actorId, approvedAt: new Date() },
        });
      }),
    );
  }

  /**
   * Reject a REQUESTED refund (for example one whose amount is no longer owed
   * after a bounce charge), so the correct amount can be requested. Posts
   * nothing: a requested refund has no ledger entry. The reason is audited.
   */
  async reject(companyId: string, refundId: string, reason: string, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const found = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!found) throw new NotFoundException('Refund not found');
        await lockBookingRefunds(tx, found.bookingId);
        const refund = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== REFUND_STATUS.REQUESTED) {
          throw new ConflictException(`Refund is ${refund.status}; only REQUESTED can be rejected`);
        }
        const updated = await tx.refund.update({ where: { id: refundId }, data: { status: REFUND_STATUS.REJECTED } });
        await tx.auditLog.create({
          data: {
            companyId,
            userId: actorId,
            entityType: 'Refund',
            entityId: refundId,
            action: 'REFUND_REJECTED',
            after: { reason, amountPaise: refund.amountPaise.toString(), bookingId: refund.bookingId },
            ipAddress: getCurrentIpAddress() ?? null,
          },
        });
        return updated;
      }),
    );
  }

  /** Record the cash outflow (PaymentVoucher). No further ledger entry. */
  async pay(companyId: string, refundId: string, dto: PayRefundDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const found = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!found) throw new NotFoundException('Refund not found');
        await lockBookingRefunds(tx, found.bookingId);
        const refund = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== REFUND_STATUS.APPROVED) {
          throw new ConflictException(`Refund is ${refund.status}; only APPROVED can be paid`);
        }

        await assertOwnedByCompany(tx, companyId, [['bank', dto.bankId, 'Bank']]);
        // Its approval already debited the ledger. A positive balance means the
        // approved refunds now exceed the money held (e.g. a receipt reversed).
        const balance = await this.ledger.balanceInTx(tx, companyId, refund.bookingId);
        if (balance > 0n) {
          throw new BadRequestException(
            `Refund (${refund.amountPaise}) exceeds what the booking's ledger covers: approved refunds are ${balance} more than the money held`,
          );
        }
        const voucher = await tx.paymentVoucher.create({
          data: {
            companyId,
            bookingId: refund.bookingId,
            refundId,
            amountPaise: refund.amountPaise,
            mode: dto.mode,
            bankId: dto.bankId ?? null,
            instrumentNumber: dto.instrumentNumber ?? null,
            instrumentDate: dto.instrumentDate ?? null,
            status: VOUCHER_STATUS_ISSUED,
            createdById: actorId,
          },
        });
        await tx.refund.update({ where: { id: refundId }, data: { status: REFUND_STATUS.PAID } });
        return voucher;
      }),
    );
  }

  /** A refund cheque bounced: re-open the obligation + apply a bounce charge. */
  async voucherBounced(companyId: string, voucherId: string, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const found = await tx.paymentVoucher.findFirst({ where: { id: voucherId, companyId } });
        if (!found) throw new NotFoundException('Payment voucher not found');
        await lockBookingRefunds(tx, found.bookingId);
        const voucher = await tx.paymentVoucher.findFirst({ where: { id: voucherId, companyId } });
        if (!voucher) throw new NotFoundException('Payment voucher not found');
        if (voucher.status !== VOUCHER_STATUS_ISSUED) {
          throw new ConflictException(`Voucher is ${voucher.status}`);
        }

        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const bounceCharge = config?.chequeBounceChargePaise ?? 0n;

        await this.ledger.post(tx, companyId, [
          {
            bookingId: voucher.bookingId,
            entryType: LEDGER_ENTRY_TYPE.REFUND_BOUNCE_REVERSAL,
            signedAmountPaise: -voucher.amountPaise, // credit: re-opens what we owe the customer
            reason: 'Refund cheque bounced',
            effectiveDate: new Date(),
            createdById: actorId,
          },
          ...(bounceCharge > 0n
            ? [
                {
                  bookingId: voucher.bookingId,
                  entryType: LEDGER_ENTRY_TYPE.BOUNCE_CHARGE,
                  signedAmountPaise: bounceCharge,
                  reason: 'Refund cheque bounce charge',
                  effectiveDate: new Date(),
                  createdById: actorId,
                },
              ]
            : []),
        ]);

        await tx.paymentVoucher.update({ where: { id: voucherId }, data: { status: 'BOUNCED' } });
        // Back to REQUESTED, not APPROVED: the reversal above re-credits the money
        // as owed, so paying again needs a new approval, which re-checks what is
        // owed and posts the approval debit again.
        if (voucher.refundId) {
          await tx.refund.update({
            where: { id: voucher.refundId },
            data: { status: REFUND_STATUS.REQUESTED, approvedById: null, approvedAt: null },
          });
        }
        return { voucherId, bounced: true };
      }),
    );
  }
}

/** One refund decision at a time per booking (request, approve, pay). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lockBookingRefunds(tx: any, bookingId: string): Promise<void> {
  // Raw SQL: advisory locks have no Prisma API; the booking id is a bound parameter.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('refund:' || ${bookingId}::text, 0))`;
}
