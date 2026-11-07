import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  LEDGER_ENTRY_TYPE,
  CHEQUE_CLEARANCE_STATUS,
  INSTALLMENT_STATUS,
  RECEIPT_MODE,
  NOTIFICATION_EVENT,
  formatReceiptNumber,
  formatInr,
  type CreateReceiptDto,
  type ChequeEventDto,
  type TdsCertificateDto,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { LedgerService } from './ledger.service';
import { NumberSequenceService } from './number-sequence.service';
import { NotificationService } from '../notifications/notification.service';

const CHEQUE_LIKE = new Set<string>([RECEIPT_MODE.CHEQUE, RECEIPT_MODE.DD]);

@Injectable()
export class ReceiptService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly numbers: NumberSequenceService,
    private readonly notifications: NotificationService,
  ) {}

  async createReceipt(companyId: string, dto: CreateReceiptDto, actorId: string | null) {
    const { receipt, primaryApplicantId } = await this.createReceiptTx(companyId, dto, actorId);

    // Fired AFTER the transaction commits — provider.send() is external
    // I/O, never allowed inside withTenantTx (CLAUDE.md Phase 1 rule).
    if (primaryApplicantId) {
      await this.notifications.notify(
        companyId,
        NOTIFICATION_EVENT.RECEIPT_CONFIRMED,
        { applicantId: primaryApplicantId },
        'Payment received',
        `We've received your payment of ${formatInr(receipt.grossAmountPaise)} (receipt ${receipt.receiptNumber}).`,
      );
    }

    return receipt;
  }

  private async createReceiptTx(companyId: string, dto: CreateReceiptDto, actorId: string | null) {
    const allocTotal = dto.allocations.reduce((s, a) => s + a.amountPaise, 0n);
    if (allocTotal !== dto.grossAmountPaise) {
      throw new BadRequestException(
        `Allocations (${allocTotal}) must sum to the gross amount (${dto.grossAmountPaise})`,
      );
    }
    if (dto.tdsDeductedPaise > dto.grossAmountPaise) {
      throw new BadRequestException('TDS deducted cannot exceed the gross amount');
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: dto.bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');

        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const fyStartMonth = config?.fyStartMonth ?? 4;

        // Validate + lock each target installment.
        const installments = new Map<string, { id: string; amountPaise: bigint; allocatedPaise: bigint }>();
        for (const a of dto.allocations) {
          if (installments.has(a.installmentId)) continue;
          const inst = await tx.installment.findFirst({
            where: { id: a.installmentId, companyId, bookingId: dto.bookingId },
          });
          if (!inst) throw new NotFoundException(`Installment ${a.installmentId} not found on this booking`);
          // The receipt itself is never rejected for this — a customer
          // transferring money ahead of a milestone is normal. What's
          // rejected is ALLOCATING it against an installment that hasn't
          // been raised yet: nothing is due, so there's nothing to apply
          // the payment "against" in the ledger sense. The real fix for
          // "customer paid early, nowhere raised to put it yet" is a
          // suspense account (competitive-gap-analysis.md names this gap;
          // not built in this pass) — see
          // internal plan construction-linked-demand-fix.md §revision 2 for
          // why this rejection is deliberately narrow and where a future
          // suspense sweep would hook in.
          if (inst.dueDate === null) {
            throw new BadRequestException(
              `Installment ${a.installmentId} has not been raised yet — it cannot receive an allocation`,
            );
          }
          installments.set(a.installmentId, inst);
        }
        // No over-allocation beyond an installment's amount.
        const addByInst = new Map<string, bigint>();
        for (const a of dto.allocations) {
          addByInst.set(a.installmentId, (addByInst.get(a.installmentId) ?? 0n) + a.amountPaise);
        }
        for (const [instId, add] of addByInst) {
          const inst = installments.get(instId)!;
          if (inst.allocatedPaise + add > inst.amountPaise) {
            throw new BadRequestException(
              `Allocation to installment ${instId} (${inst.allocatedPaise + add}) exceeds its amount (${inst.amountPaise})`,
            );
          }
        }

        // TDS applicability (194-IA): only if the booking consideration meets
        // the effective threshold. Sub-threshold bookings post no TDS receivable.
        if (dto.tdsDeductedPaise > 0n) {
          const rule = await tx.tdsRule.findFirst({
            where: {
              companyId,
              section: '194-IA',
              effectiveFrom: { lte: dto.receiptDate },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: dto.receiptDate } }],
            },
            orderBy: { effectiveFrom: 'desc' },
          });
          if (!rule) throw new BadRequestException('No effective 194-IA TDS rule configured');
          if (booking.agreedPricePaise < rule.thresholdPaise) {
            throw new BadRequestException(
              'Booking is below the TDS threshold; no TDS should be deducted',
            );
          }
        }

        const { seq, fyLabel } = await this.numbers.allocateForFy(
          tx,
          companyId,
          'RECEIPT',
          dto.receiptDate,
          fyStartMonth,
        );
        const receiptNumber = formatReceiptNumber(fyLabel, seq);

        const isCheque = CHEQUE_LIKE.has(dto.mode);
        const receipt = await tx.receipt.create({
          data: {
            companyId,
            bookingId: dto.bookingId,
            receiptNumber,
            fyLabel,
            seqValue: seq,
            receiptDate: dto.receiptDate,
            mode: dto.mode,
            grossAmountPaise: dto.grossAmountPaise,
            receiptTypeId: dto.receiptTypeId ?? null,
            bankId: dto.bankId ?? null,
            instrumentNumber: dto.instrumentNumber ?? null,
            instrumentDate: dto.instrumentDate ?? null,
            utr: dto.utr ?? null,
            clearanceStatus: isCheque
              ? CHEQUE_CLEARANCE_STATUS.RECEIVED
              : CHEQUE_CLEARANCE_STATUS.NOT_APPLICABLE,
            createdById: actorId,
          },
        });

        if (isCheque) {
          await tx.chequeStatusEvent.create({
            data: {
              companyId,
              receiptId: receipt.id,
              status: CHEQUE_CLEARANCE_STATUS.RECEIVED,
              eventDate: dto.receiptDate,
              createdById: actorId,
            },
          });
        }

        // Allocations + ledger credits (gross) + installment cache updates.
        for (const a of dto.allocations) {
          await tx.receiptAllocation.create({
            data: { companyId, receiptId: receipt.id, installmentId: a.installmentId, amountPaise: a.amountPaise },
          });
          await this.ledger.post(tx, companyId, [
            {
              bookingId: dto.bookingId,
              entryType: LEDGER_ENTRY_TYPE.RECEIPT_ALLOC,
              signedAmountPaise: -a.amountPaise,
              installmentId: a.installmentId,
              receiptId: receipt.id,
              effectiveDate: dto.receiptDate,
              createdById: actorId,
            },
          ]);
        }
        for (const [instId, add] of addByInst) {
          await this.bumpInstallment(tx, instId, add);
        }

        // TDS receivable: keep the withheld amount visible as outstanding until
        // a certificate is recorded (requirement 3). Balance net effect of a
        // receipt with TDS = -(gross) + tds = -(cash actually received).
        if (dto.tdsDeductedPaise > 0n) {
          const [entry] = await this.ledger.post(tx, companyId, [
            {
              bookingId: dto.bookingId,
              entryType: LEDGER_ENTRY_TYPE.TDS_RECEIVABLE,
              signedAmountPaise: dto.tdsDeductedPaise,
              receiptId: receipt.id,
              reason: 'TDS 194-IA withheld — receivable until certificate',
              effectiveDate: dto.receiptDate,
              createdById: actorId,
            },
          ]);
          await tx.tdsDeduction.create({
            data: {
              companyId,
              bookingId: dto.bookingId,
              receiptId: receipt.id,
              sectionSnapshot: '194-IA',
              ratePercentSnapshot: new Prisma.Decimal(1),
              deductedPaise: dto.tdsDeductedPaise,
              receivableLedgerEntryId: entry.id,
              createdById: actorId,
            },
          });
        }

        return { receipt, primaryApplicantId: booking.primaryApplicantId as string | null };
      }),
    );
  }

  /** Advance a cheque through its lifecycle; a bounce reverses + charges. */
  async recordChequeEvent(companyId: string, receiptId: string, dto: ChequeEventDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const receipt = await tx.receipt.findFirst({ where: { id: receiptId, companyId } });
        if (!receipt) throw new NotFoundException('Receipt not found');
        if (!CHEQUE_LIKE.has(receipt.mode)) {
          throw new BadRequestException('Cheque events only apply to cheque/DD receipts');
        }
        if (
          receipt.clearanceStatus === CHEQUE_CLEARANCE_STATUS.CLEARED ||
          receipt.clearanceStatus === CHEQUE_CLEARANCE_STATUS.BOUNCED
        ) {
          throw new ConflictException(`Cheque is already ${receipt.clearanceStatus}`);
        }

        await tx.chequeStatusEvent.create({
          data: { companyId, receiptId, status: dto.status, eventDate: dto.eventDate, reason: dto.reason ?? null, createdById: actorId },
        });
        await tx.receipt.update({
          where: { id: receiptId },
          data: {
            clearanceStatus: dto.status,
            // A bounce reverses this receipt's ledger effects (below) exactly
            // like reverseReceipt()'s manual-cancel path does — it must flip
            // the same isReversed flag, or every isReversed:false query
            // (collection reports, portal receipt history, commission basis)
            // keeps counting money that was never actually collected.
            ...(dto.status === CHEQUE_CLEARANCE_STATUS.BOUNCED
              ? { isReversed: true, reversalReason: dto.reason ?? `Cheque bounced (${receipt.receiptNumber})` }
              : {}),
          },
        });

        if (dto.status === CHEQUE_CLEARANCE_STATUS.BOUNCED) {
          const config = await tx.companyConfig.findFirst({ where: { companyId } });
          await this.reverseReceiptLedger(
            tx,
            companyId,
            receipt,
            LEDGER_ENTRY_TYPE.BOUNCE_REVERSAL,
            `Cheque bounced (${receipt.receiptNumber})`,
            actorId,
            dto.eventDate,
            config?.chequeBounceChargePaise ?? 0n,
          );
        }
        return { receiptId, status: dto.status };
      }),
    );
  }

  /** Cancel a receipt = reversal entry + reason (append-only). */
  async reverseReceipt(companyId: string, receiptId: string, reason: string, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const receipt = await tx.receipt.findFirst({ where: { id: receiptId, companyId } });
        if (!receipt) throw new NotFoundException('Receipt not found');
        if (receipt.isReversed) throw new ConflictException('Receipt already reversed');
        if (receipt.clearanceStatus === CHEQUE_CLEARANCE_STATUS.BOUNCED) {
          throw new ConflictException('A bounced cheque receipt is already reversed');
        }

        await this.reverseReceiptLedger(
          tx,
          companyId,
          receipt,
          LEDGER_ENTRY_TYPE.ADJUSTMENT,
          reason,
          actorId,
          receipt.receiptDate,
          0n,
        );
        await tx.receipt.update({ where: { id: receiptId }, data: { isReversed: true, reversalReason: reason } });
        return { receiptId, reversed: true };
      }),
    );
  }

  /** Record a TDS certificate → post the credit that zeroes the receivable. */
  async recordTdsCertificate(
    companyId: string,
    tdsDeductionId: string,
    dto: TdsCertificateDto,
    actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const ded = await tx.tdsDeduction.findFirst({ where: { id: tdsDeductionId, companyId } });
        if (!ded) throw new NotFoundException('TDS deduction not found');
        const existing = await tx.tdsCertificate.findFirst({ where: { tdsDeductionId, companyId } });
        if (existing) throw new ConflictException('Certificate already recorded for this deduction');

        const [adj] = await this.ledger.post(tx, companyId, [
          {
            bookingId: ded.bookingId,
            entryType: LEDGER_ENTRY_TYPE.TDS_CERT_ADJUSTMENT,
            signedAmountPaise: -ded.deductedPaise,
            reason: `TDS certificate ${dto.certificateNumber}`,
            effectiveDate: dto.certificateDate,
            createdById: actorId,
          },
        ]);
        return tx.tdsCertificate.create({
          data: {
            companyId,
            tdsDeductionId,
            certificateNumber: dto.certificateNumber,
            certificateDate: dto.certificateDate,
            adjustmentLedgerEntryId: adj.id,
            createdById: actorId,
          },
        });
      }),
    );
  }

  /** Flag a reprint so the PDF renders a DUPLICATE watermark (Phase 4 UI). */
  async markReprint(companyId: string, receiptId: string) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const receipt = await tx.receipt.findFirst({ where: { id: receiptId, companyId } });
        if (!receipt) throw new NotFoundException('Receipt not found');
        return tx.receipt.update({
          where: { id: receiptId },
          data: { reprintCount: { increment: 1 } },
          select: { id: true, receiptNumber: true, reprintCount: true },
        });
      }),
    );
  }

  // ── helpers ──

  private async reverseReceiptLedger(
    tx: Prisma.TransactionClient,
    companyId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receipt: any,
    reversalType: (typeof LEDGER_ENTRY_TYPE)[keyof typeof LEDGER_ENTRY_TYPE],
    reason: string,
    actorId: string | null,
    effectiveDate: Date,
    bounceChargePaise: bigint,
  ) {
    // Reverse the receipt's own credits/debits (RECEIPT_ALLOC + TDS_RECEIVABLE)
    // that have not already been reversed.
    const entries = await tx.ledgerEntry.findMany({
      where: {
        companyId,
        receiptId: receipt.id,
        entryType: { in: [LEDGER_ENTRY_TYPE.RECEIPT_ALLOC, LEDGER_ENTRY_TYPE.TDS_RECEIVABLE] },
      },
    });
    const alreadyReversed = new Set(
      (
        await tx.ledgerEntry.findMany({
          where: { companyId, reversalOfEntryId: { in: entries.map((e: { id: string }) => e.id) } },
          select: { reversalOfEntryId: true },
        })
      ).map((r: { reversalOfEntryId: string | null }) => r.reversalOfEntryId),
    );

    for (const e of entries) {
      if (alreadyReversed.has(e.id)) continue;
      await this.ledger.post(tx, companyId, [
        {
          bookingId: receipt.bookingId,
          entryType: reversalType,
          signedAmountPaise: -e.signedAmountPaise,
          installmentId: e.installmentId,
          receiptId: receipt.id,
          reversalOfEntryId: e.id,
          reason,
          effectiveDate,
          createdById: actorId,
        },
      ]);
      if (e.entryType === LEDGER_ENTRY_TYPE.RECEIPT_ALLOC && e.installmentId) {
        // e.signedAmountPaise is negative (a credit); reduce allocation by its magnitude.
        await this.bumpInstallment(tx, e.installmentId, e.signedAmountPaise);
      }
    }

    if (bounceChargePaise > 0n) {
      await this.ledger.post(tx, companyId, [
        {
          bookingId: receipt.bookingId,
          entryType: LEDGER_ENTRY_TYPE.BOUNCE_CHARGE,
          signedAmountPaise: bounceChargePaise,
          receiptId: receipt.id,
          reason,
          effectiveDate,
          createdById: actorId,
        },
      ]);
    }
  }

  /** Adjust an installment's allocated cache by `delta` and recompute status. */
  private async bumpInstallment(tx: Prisma.TransactionClient, installmentId: string, delta: bigint) {
    const inst = await tx.installment.findFirst({ where: { id: installmentId } });
    if (!inst) return;
    const allocated = inst.allocatedPaise + delta;
    const status =
      allocated >= inst.amountPaise
        ? INSTALLMENT_STATUS.PAID
        : allocated > 0n
          ? INSTALLMENT_STATUS.PART_PAID
          : INSTALLMENT_STATUS.UNPAID;
    await tx.installment.update({
      where: { id: installmentId },
      data: { allocatedPaise: allocated, status },
    });
  }
}
