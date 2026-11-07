import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  BOOKING_STATUS,
  LEDGER_ENTRY_TYPE,
  formatBookingNumber,
  type CreateBookingDto,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { UnitStateMachineService } from '../inventory/unit-state-machine.service';
import { LedgerService } from './ledger.service';
import { NumberSequenceService } from './number-sequence.service';
import { priceCostLines } from './booking-pricing';

const BOOKABLE_FROM = new Set(['AVAILABLE', 'HELD']);

@Injectable()
export class BookingService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly stateMachine: UnitStateMachineService,
    private readonly ledger: LedgerService,
    private readonly numbers: NumberSequenceService,
  ) {}

  async createBooking(companyId: string, dto: CreateBookingDto, actorId: string | null) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const unit = await tx.unit.findFirst({
          where: { id: dto.unitId, companyId },
          include: { project: { include: { areaLocation: true } } },
        });
        if (!unit) throw new NotFoundException('Unit not found');
        if (!BOOKABLE_FROM.has(unit.status)) {
          throw new BadRequestException(
            `Unit ${unit.number} is ${unit.status}; only AVAILABLE or HELD units can be booked`,
          );
        }

        const applicant = await tx.applicant.findFirst({
          where: { id: dto.primaryApplicantId, companyId },
        });
        if (!applicant) throw new NotFoundException('Primary applicant not found');
        if (applicant.mergedIntoId) {
          throw new BadRequestException('Primary applicant has been merged into another applicant');
        }

        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const fyStartMonth = config?.fyStartMonth ?? 4;

        // Cost lines, GST and the agreed price (moved unchanged to booking-pricing.ts).
        const { placeOfSupplyStateCode, costLines, agreedPricePaise } = await priceCostLines(
          tx,
          companyId,
          unit,
          config,
          dto,
        );

        const { seq, fyLabel } = await this.numbers.allocateForFy(
          tx,
          companyId,
          'BOOKING',
          dto.bookingDate,
          fyStartMonth,
        );
        const bookingNumber = formatBookingNumber(fyLabel, seq);

        const booking = await tx.booking.create({
          data: {
            companyId,
            unitId: dto.unitId,
            primaryApplicantId: dto.primaryApplicantId,
            bookingNumber,
            status: BOOKING_STATUS.BOOKED,
            agreedPricePaise,
            placeOfSupplyStateCode,
            paymentPlanTemplateId: dto.paymentPlanTemplateId ?? null,
            bookingDate: dto.bookingDate,
            createdById: actorId,
          },
        });

        // Co-applicants.
        for (let i = 0; i < dto.coApplicantIds.length; i++) {
          await tx.bookingCoApplicant.create({
            data: {
              companyId,
              bookingId: booking.id,
              applicantId: dto.coApplicantIds[i],
              ordinal: i + 2,
            },
          });
        }

        // Cost-line snapshot rows.
        for (const l of costLines) {
          await tx.bookingCostLine.create({ data: { companyId, bookingId: booking.id, ...l } });
        }

        // Ledger: post the cost breakup as CHARGE debits. Σ == agreed price,
        // so the booking balance opens at the full consideration owed.
        await this.ledger.post(
          tx,
          companyId,
          costLines.map((l) => ({
            bookingId: booking.id,
            entryType: LEDGER_ENTRY_TYPE.CHARGE,
            signedAmountPaise: l.lineTotalPaise,
            reason: l.label,
            effectiveDate: dto.bookingDate,
            createdById: actorId,
          })),
        );

        // Move the unit to BOOKED via the state machine (system actor). Reuses
        // this transaction (same company), so it's atomic with the booking.
        await this.stateMachine.transition(
          companyId,
          dto.unitId,
          'BOOKED',
          'system',
          actorId,
          `Booking ${bookingNumber}`,
        );

        return booking;
      }),
    );
  }

  async allot(companyId: string, bookingId: string, allotmentDate: Date, actorId: string | null) {
    return this.advance(companyId, bookingId, 'ALLOTTED', allotmentDate, actorId);
  }

  async register(companyId: string, bookingId: string, registrationDate: Date, actorId: string | null) {
    return this.advance(companyId, bookingId, 'REGISTERED', registrationDate, actorId);
  }

  private async advance(
    companyId: string,
    bookingId: string,
    to: 'ALLOTTED' | 'REGISTERED',
    date: Date,
    actorId: string | null,
  ) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: bookingId, companyId } });
        if (!booking) throw new NotFoundException('Booking not found');

        const expectedFrom = to === 'ALLOTTED' ? BOOKING_STATUS.BOOKED : BOOKING_STATUS.ALLOTTED;
        if (booking.status !== expectedFrom) {
          throw new BadRequestException(
            `Booking is ${booking.status}; expected ${expectedFrom} before ${to}`,
          );
        }

        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: to,
            ...(to === 'ALLOTTED' ? { allotmentDate: date } : { registrationDate: date }),
          },
        });

        await this.stateMachine.transition(companyId, booking.unitId, to, 'system', actorId, `Booking ${booking.bookingNumber}`);

        return { bookingId, status: to };
      }),
    );
  }

  async findOne(companyId: string, id: string) {
    const booking = await this.systemPrisma.booking.findFirst({
      where: { id, companyId },
      include: {
        unit: true,
        primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } },
        coApplicants: { include: { applicant: { omit: { panCiphertext: true, panKeyVersion: true } } } },
        costLines: { orderBy: { sortOrder: 'asc' } },
        paymentPlans: { where: { isActive: true }, include: { installments: { orderBy: { seq: 'asc' } } } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const attachedInterestRule = booking.interestRuleId
      ? await this.systemPrisma.interestRule.findFirst({
          where: { id: booking.interestRuleId, companyId },
          select: { id: true, name: true, ratePercent: true, rateType: true },
        })
      : null;
    const balancePaise = await this.ledger.balance(companyId, id);
    return { ...booking, attachedInterestRule, balancePaise: balancePaise.toString() };
  }
}
