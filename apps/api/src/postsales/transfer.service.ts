import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import {
  BOOKING_STATUS,
  LEDGER_ENTRY_TYPE,
  TRANSFER_TYPE,
  formatBookingNumber,
  percentOf,
  type CreateTransferDto,
} from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { UnitStateMachineService } from '../inventory/unit-state-machine.service';
import { LedgerService } from './ledger.service';
import { NumberSequenceService } from './number-sequence.service';

const TRANSFERABLE_FROM = new Set<string>([BOOKING_STATUS.BOOKED, BOOKING_STATUS.ALLOTTED]);

@Injectable()
export class TransferService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly stateMachine: UnitStateMachineService,
    private readonly ledger: LedgerService,
    private readonly numbers: NumberSequenceService,
  ) {}

  /**
   * Transfer a booking to a new unit or a new applicant. The old ledger is
   * closed with a TRANSFER_CARRY_OUT credit (→ balance 0); the new booking
   * opens with an equal TRANSFER_CARRY_IN debit, so total money across the two
   * ledgers is invariant (the carry pair nets to zero). Any transfer fee is a
   * separately-typed TRANSFER_FEE debit — legitimately new money, excluded
   * from the invariant.
   */
  async transfer(companyId: string, fromBookingId: string, dto: CreateTransferDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const from = await tx.booking.findFirst({ where: { id: fromBookingId, companyId } });
        if (!from) throw new NotFoundException('Source booking not found');
        if (!TRANSFERABLE_FROM.has(from.status)) {
          throw new BadRequestException(`Booking is ${from.status}; only BOOKED/ALLOTTED can transfer`);
        }

        if (dto.transferType === TRANSFER_TYPE.UNIT && !dto.toUnitId) {
          throw new BadRequestException('UNIT transfer requires toUnitId');
        }
        if (dto.transferType === TRANSFER_TYPE.APPLICANT && !dto.toApplicantId) {
          throw new BadRequestException('APPLICANT transfer requires toApplicantId');
        }

        const carryForward = await this.ledger.balanceInTx(tx, companyId, fromBookingId);
        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const fyStartMonth = config?.fyStartMonth ?? 4;

        // Transfer fee from master (optional).
        let transferFeePaise = 0n;
        if (dto.transferFeeRuleId) {
          const rule = await tx.transferFeeRule.findFirst({ where: { id: dto.transferFeeRuleId, companyId } });
          if (!rule) throw new NotFoundException('Transfer fee rule not found');
          transferFeePaise =
            rule.feeType === 'FIXED'
              ? (rule.amountPaise ?? 0n)
              : percentOf(from.agreedPricePaise, Math.round(Number(rule.percentage ?? 0) * 100));
        }

        // Determine the new unit + applicant.
        const now = new Date();
        let toUnitId = from.unitId;
        let toApplicantId = from.primaryApplicantId;

        if (dto.transferType === TRANSFER_TYPE.UNIT) {
          const newUnit = await tx.unit.findFirst({ where: { id: dto.toUnitId, companyId } });
          if (!newUnit) throw new NotFoundException('Destination unit not found');
          if (!['AVAILABLE', 'HELD'].includes(newUnit.status)) {
            throw new BadRequestException(`Destination unit is ${newUnit.status}; must be AVAILABLE or HELD`);
          }
          toUnitId = dto.toUnitId as string;
        } else {
          const newApplicant = await tx.applicant.findFirst({ where: { id: dto.toApplicantId, companyId } });
          if (!newApplicant) throw new NotFoundException('Destination applicant not found');
          toApplicantId = dto.toApplicantId as string;
        }

        // Close the old booking's ledger and mark it transferred out.
        await this.ledger.post(tx, companyId, [
          {
            bookingId: fromBookingId,
            entryType: LEDGER_ENTRY_TYPE.TRANSFER_CARRY_OUT,
            signedAmountPaise: -carryForward,
            reason: `Transfer out (${from.bookingNumber})`,
            effectiveDate: now,
            createdById: actorId,
          },
        ]);
        await tx.booking.update({ where: { id: fromBookingId }, data: { status: BOOKING_STATUS.TRANSFERRED_OUT } });

        // Open the new booking.
        const { seq, fyLabel } = await this.numbers.allocateForFy(tx, companyId, 'BOOKING', now, fyStartMonth);
        const toBooking = await tx.booking.create({
          data: {
            companyId,
            unitId: toUnitId,
            primaryApplicantId: toApplicantId,
            bookingNumber: formatBookingNumber(fyLabel, seq),
            status: BOOKING_STATUS.BOOKED,
            agreedPricePaise: from.agreedPricePaise,
            placeOfSupplyStateCode: from.placeOfSupplyStateCode,
            paymentPlanTemplateId: from.paymentPlanTemplateId,
            interestRuleId: from.interestRuleId,
            // Interest on the new booking runs from the transfer date (v0.9).
            interestFromDate: from.interestRuleId ? now : null,
            bookingDate: now,
            createdById: actorId,
          },
        });

        // Carry the outstanding balance forward.
        await this.ledger.post(tx, companyId, [
          {
            bookingId: toBooking.id,
            entryType: LEDGER_ENTRY_TYPE.TRANSFER_CARRY_IN,
            signedAmountPaise: carryForward,
            reason: `Transfer in (${toBooking.bookingNumber})`,
            effectiveDate: now,
            createdById: actorId,
          },
        ]);

        if (transferFeePaise > 0n) {
          await this.ledger.post(tx, companyId, [
            {
              bookingId: toBooking.id,
              entryType: LEDGER_ENTRY_TYPE.TRANSFER_FEE,
              signedAmountPaise: transferFeePaise,
              reason: 'Transfer fee',
              effectiveDate: now,
              createdById: actorId,
            },
          ]);
        }

        // Unit state moves (system): UNIT transfer releases the old unit and
        // books the new one. APPLICANT transfer keeps the same booked unit.
        if (dto.transferType === TRANSFER_TYPE.UNIT) {
          await this.stateMachine.transition(companyId, from.unitId, 'CANCELLED', 'system', actorId, `Transfer ${from.bookingNumber}`);
          await this.stateMachine.transition(companyId, from.unitId, 'AVAILABLE', 'system', actorId, `Transfer ${from.bookingNumber}`);
          await this.stateMachine.transition(companyId, toUnitId, 'BOOKED', 'system', actorId, `Transfer ${toBooking.bookingNumber}`);
        }

        const transfer = await tx.transfer.create({
          data: {
            companyId,
            fromBookingId,
            toBookingId: toBooking.id,
            transferType: dto.transferType,
            transferFeeRuleId: dto.transferFeeRuleId ?? null,
            transferFeePaise,
            carryForwardPaise: carryForward,
            reason: dto.reason ?? null,
            createdById: actorId,
          },
        });

        return { transfer, toBookingId: toBooking.id };
      }),
    );
  }
}
