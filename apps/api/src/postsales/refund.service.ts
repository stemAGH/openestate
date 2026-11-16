import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import {
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

        const balance = await this.ledger.balanceInTx(tx, companyId, bookingId);
        const owedToCustomer = balance < 0n ? -balance : 0n;
        if (dto.amountPaise > owedToCustomer) {
          throw new BadRequestException(
            `Refund (${dto.amountPaise}) exceeds the amount owed to the customer (${owedToCustomer})`,
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
        const refund = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== REFUND_STATUS.REQUESTED) {
          throw new ConflictException(`Refund is ${refund.status}; only REQUESTED can be approved`);
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

  /** Record the cash outflow (PaymentVoucher). No further ledger entry. */
  async pay(companyId: string, refundId: string, dto: PayRefundDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const refund = await tx.refund.findFirst({ where: { id: refundId, companyId } });
        if (!refund) throw new NotFoundException('Refund not found');
        if (refund.status !== REFUND_STATUS.APPROVED) {
          throw new ConflictException(`Refund is ${refund.status}; only APPROVED can be paid`);
        }

        await assertOwnedByCompany(tx, companyId, [['bank', dto.bankId, 'Bank']]);
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
        // Move the refund back to APPROVED so it can be re-paid.
        if (voucher.refundId) {
          await tx.refund.update({ where: { id: voucher.refundId }, data: { status: REFUND_STATUS.APPROVED } });
        }
        return { voucherId, bounced: true };
      }),
    );
  }
}
