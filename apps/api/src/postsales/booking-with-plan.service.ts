import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import {
  formatInr,
  type BookingQuoteDto,
  type CreateBookingDto,
  type CreateBookingWithPlanDto,
} from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { BookingService } from './booking.service';
import { PaymentPlanService } from './payment-plan.service';
import { BookingInterestRuleService } from './booking-interest-rule.service';
import { priceCostLines } from './booking-pricing';

/**
 * Booking quote and atomic booking-with-plan.
 *
 * The quote runs the booking's own pricing (booking-pricing.ts) and writes
 * nothing; it is a preview only. createWithPlan recalculates on the server.
 * It runs the booking, the payment plan and the optional interest rule in
 * ONE transaction: each service opens its own withTenantTx for the same
 * company, which joins this outer one, so any refusal at any step rolls back
 * everything (booking, number, cost lines, ledger, unit status, plan,
 * installments, audit rows) and the unit stays free.
 */
@Injectable()
export class BookingWithPlanService {
  private readonly logger = new Logger(BookingWithPlanService.name);

  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly bookings: BookingService,
    private readonly plans: PaymentPlanService,
    private readonly interestRules: BookingInterestRuleService,
  ) {}

  async quote(companyId: string, dto: BookingQuoteDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const unit = await tx.unit.findFirst({
          where: { id: dto.unitId, companyId },
          include: { project: { include: { areaLocation: true } } },
        });
        if (!unit) throw new NotFoundException('Unit not found');
        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const priced = await priceCostLines(tx, companyId, unit, config, dto);
        const totalBeforeGstPaise = priced.costLines.reduce((s, l) => s + l.baseAmountPaise, 0n);
        return {
          unitId: unit.id,
          unitStatus: unit.status,
          placeOfSupplyStateCode: priced.placeOfSupplyStateCode,
          costLines: priced.costLines,
          totalBeforeGstPaise,
          gstPaise: priced.agreedPricePaise - totalBeforeGstPaise,
          agreedPricePaise: priced.agreedPricePaise,
        };
      }),
    );
  }

  async createWithPlan(companyId: string, dto: CreateBookingWithPlanDto, actorId: string | null) {
    try {
      return await runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, async () => {
          const { plan, expectedAgreedPricePaise, interestRuleId, ...rest } = dto;
          const bookingDto: CreateBookingDto = {
            ...rest,
            paymentPlanTemplateId: plan.mode === 'template' ? plan.templateId : undefined,
          };
          const booking = await this.bookings.createBooking(companyId, bookingDto, actorId);
          const price = booking.agreedPricePaise as bigint;

          if (expectedAgreedPricePaise !== undefined && expectedAgreedPricePaise !== price) {
            throw new ConflictException(
              `The price changed since the quote: quoted ${formatInr(expectedAgreedPricePaise)}, ` +
                `now ${formatInr(price)} (GST included). Review the price and book again.`,
            );
          }

          let created;
          if (plan.mode === 'template') {
            created = await this.plans.instantiateFromTemplate(companyId, booking.id, plan.templateId, actorId);
          } else {
            const amounts = plan.installments.map((i) => i.amountPaise);
            if (amounts.every((a) => a !== undefined)) {
              const sum = amounts.reduce((s: bigint, a) => s + (a as bigint), 0n);
              if (sum !== price) {
                throw new BadRequestException(
                  `Payment plan refused: the installments add up to ${formatInr(sum)} but the ` +
                    `GST-inclusive total is ${formatInr(price)}. Make them add up to the total and book again.`,
                );
              }
            }
            created = await this.plans.createCustomPlan(
              companyId,
              booking.id,
              { name: plan.name, isCustom: true, installments: plan.installments },
              actorId,
            );
          }

          if (interestRuleId) {
            await this.interestRules.setRule(companyId, booking.id, interestRuleId, actorId);
          }

          return { booking, plan: created };
        }),
      );
    } catch (e) {
      // The reason the person booking saw, so a refused booking can be traced.
      this.logger.warn(
        `Booking refused (company ${companyId}, unit ${dto.unitId}): ${(e as Error).message}`,
      );
      throw e;
    }
  }
}
