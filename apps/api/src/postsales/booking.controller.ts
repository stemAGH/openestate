import { Body, Controller, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { withTenantTx, runWithTenant } from '@openestate/db';
import {
  createBookingSchema,
  createPaymentPlanSchema,
  extraChargeSchema,
  interestWaiverSchema,
  setBookingInterestRuleSchema,
  createTransferSchema,
  cancellationSchema,
  requestNocSchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequireAnyPermission, RequirePermissions } from '../auth/guards/permissions.guard';
import { TENANT_PRISMA } from '../database/database.module';
import { BookingService } from './booking.service';
import { PaymentPlanService } from './payment-plan.service';
import { ExtraChargeService } from './extra-charge.service';
import { InterestService } from './interest.service';
import { BookingInterestRuleService } from './booking-interest-rule.service';
import { TransferService } from './transfer.service';
import { CancellationService } from './cancellation.service';
import { BrokerService } from '../brokers/broker.service';
import { NocService } from '../brokers/noc.service';
import { CommissionService } from '../commission/commission.service';
import { BookingCostLineVerifier } from './booking-cost-line-verifier.service';
import { InquiryService } from '../presales/inquiry.service';

class CreateBookingDto extends createZodDto(createBookingSchema) {}
class AssignBrokerDto extends createZodDto(z.object({ brokerId: z.string().uuid() }).strict()) {}
class AttachSourceInquiryDto extends createZodDto(z.object({ inquiryId: z.string().uuid() }).strict()) {}
class CreatePaymentPlanDto extends createZodDto(createPaymentPlanSchema) {}
class ExtraChargeDto extends createZodDto(extraChargeSchema) {}
class InterestWaiverDto extends createZodDto(interestWaiverSchema) {}
class SetInterestRuleDto extends createZodDto(setBookingInterestRuleSchema) {}
class CreateTransferDto extends createZodDto(createTransferSchema) {}
class CancellationDto extends createZodDto(cancellationSchema) {}
class RequestNocDto extends createZodDto(requestNocSchema) {}
class DateBodyDto extends createZodDto(z.object({ date: z.coerce.date() }).strict()) {}
class TemplateBodyDto extends createZodDto(z.object({ templateId: z.string().uuid() }).strict()) {}

@ApiTags('Bookings')
@Controller('bookings')
export class BookingController {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly bookings: BookingService,
    private readonly plans: PaymentPlanService,
    private readonly extraCharges: ExtraChargeService,
    private readonly interest: InterestService,
    private readonly transfers: TransferService,
    private readonly cancellations: CancellationService,
    private readonly brokerService: BrokerService,
    private readonly nocs: NocService,
    private readonly commissions: CommissionService,
    private readonly costLineVerifier: BookingCostLineVerifier,
    private readonly inquiries: InquiryService,
    private readonly interestRules: BookingInterestRuleService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Create a booking (books the unit; posts the cost breakup to the ledger)' })
  async create(@Body() dto: CreateBookingDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    // Precondition check on the DTO, upstream of the frozen BookingService
    // — see BookingCostLineVerifier's own doc comment for why this isn't
    // inside the service itself (plotted-farmhouse-inventory.md §7.4).
    await this.costLineVerifier.verifyForCreate(u.companyId, dto.unitId, dto.costLines);
    return this.bookings.createBooking(u.companyId, dto, u.sub);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_READ)
  @ApiOperation({ summary: 'Get a booking with its ledger balance' })
  get(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.findOne(u.companyId, id);
  }

  @Post(':id/allot')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_ALLOT)
  @ApiOperation({ summary: 'Allot (BOOKED → ALLOTTED)' })
  allot(@Param('id') id: string, @Body() dto: DateBodyDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.allot(u.companyId, id, dto.date, u.sub);
  }

  @Post(':id/register')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_REGISTER)
  @ApiOperation({ summary: 'Register (ALLOTTED → REGISTERED)' })
  register(@Param('id') id: string, @Body() dto: DateBodyDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.bookings.register(u.companyId, id, dto.date, u.sub);
  }

  @Post(':id/plan/from-template')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_EDIT)
  @ApiOperation({ summary: 'Instantiate a payment plan from a template' })
  planFromTemplate(@Param('id') id: string, @Body() dto: TemplateBodyDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.instantiateFromTemplate(u.companyId, id, dto.templateId, u.sub);
  }

  @Post(':id/plan/custom')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_EDIT)
  @ApiOperation({ summary: 'Create a custom payment plan' })
  planCustom(@Param('id') id: string, @Body() dto: CreatePaymentPlanDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.createCustomPlan(u.companyId, id, dto, u.sub);
  }

  @Post(':id/plan/edit')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_EDIT)
  @ApiOperation({ summary: 'Edit the plan (only unpaid installments regenerate)' })
  planEdit(@Param('id') id: string, @Body() dto: CreatePaymentPlanDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.editPlan(u.companyId, id, dto.installments, u.sub);
  }

  @Get(':id/plan')
  @RequirePermissions(PERMISSIONS.POSTSALES_PLAN_READ)
  @ApiOperation({ summary: 'Get the active payment plan / schedule' })
  plan(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.plans.getActivePlan(u.companyId, id);
  }

  @Post(':id/extra-charge')
  @RequirePermissions(PERMISSIONS.POSTSALES_EXTRA_CHARGE_CREATE)
  @ApiOperation({ summary: 'Add an off-schedule charge (GST snapshotted at entry)' })
  extraCharge(@Param('id') id: string, @Body() dto: ExtraChargeDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.extraCharges.add(u.companyId, id, dto, u.sub);
  }

  @Put(':id/interest-rule')
  @RequirePermissions(PERMISSIONS.POSTSALES_INTEREST_MANAGE)
  @ApiOperation({
    summary:
      'Attach, change or remove the delay-interest rule (null removes). Interest runs from today; a change first settles up to today under the old rule. SIMPLE rules only.',
  })
  setInterestRule(@Param('id') id: string, @Body() dto: SetInterestRuleDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.interestRules.setRule(u.companyId, id, dto.interestRuleId, u.sub);
  }

  @Post(':id/interest/accrue')
  @RequireAnyPermission(PERMISSIONS.POSTSALES_INTEREST_MANAGE, PERMISSIONS.POSTSALES_INTEREST_WAIVE)
  @ApiOperation({ summary: 'Accrue delay interest up to today (idempotent)' })
  accrue(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.interest.accrueForBooking(u.companyId, id);
  }

  @Post(':id/interest/waive')
  @RequirePermissions(PERMISSIONS.POSTSALES_INTEREST_WAIVE)
  @ApiOperation({ summary: 'Waive interest (audited credit)' })
  waive(@Param('id') id: string, @Body() dto: InterestWaiverDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.interest.waiveInterest(u.companyId, id, dto, u.sub);
  }

  @Post(':id/transfer')
  @RequirePermissions(PERMISSIONS.POSTSALES_TRANSFER_CREATE)
  @ApiOperation({ summary: 'Transfer to a new unit or applicant (carry-forward + fee)' })
  transfer(@Param('id') id: string, @Body() dto: CreateTransferDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.transfers.transfer(u.companyId, id, dto, u.sub);
  }

  @Post(':id/broker')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Assign the sourcing broker for a booking (Booking.brokerId — a separate call, same pattern as plan instantiation)' })
  assignBroker(@Param('id') id: string, @Body() dto: AssignBrokerDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokerService.assignToBooking(u.companyId, id, dto.brokerId);
  }

  @Post(':id/source-inquiry')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Link the inquiry this booking converted from (Booking.sourceInquiryId — a separate call, same pattern as broker assignment); flips the inquiry to SUCCESSFUL if it wasn\'t already' })
  attachSourceInquiry(@Param('id') id: string, @Body() dto: AttachSourceInquiryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.inquiries.attachBooking(u.companyId, dto.inquiryId, id, u.sub);
  }

  @Post(':id/commission/accrue')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CREATE)
  @ApiOperation({ summary: 'Accrue broker commission up to the current collection state (idempotent; no-ops if no sourcing broker)' })
  accrueCommission(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.commissions.accrueForBooking(u.companyId, id, u.sub);
  }

  @Post(':id/noc/request')
  @RequirePermissions(PERMISSIONS.POSTSALES_NOC_REQUEST)
  @ApiOperation({ summary: 'Request a broker NOC for this booking (a cancellation prerequisite when a sourcing broker is set)' })
  requestNoc(@Param('id') id: string, @Body() dto: RequestNocDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.nocs.request(u.companyId, id, dto, u.sub);
  }

  /**
   * Wraps the NOC gate, the frozen CancellationService.cancel(), and
   * CommissionService.handleBookingCancelled() in ONE outer transaction —
   * no changes to either frozen/existing service were needed for this: both
   * open their own withTenantTx(tenantPrisma, companyId, ...) internally,
   * and withTenantTx's AsyncLocalStorage-based nesting-reuse (see
   * CLAUDE.md's Phase 5 decisions) makes them transparently join THIS
   * transaction instead of opening their own. If handleBookingCancelled
   * throws, the whole tx rolls back — including cancellationService.cancel()'s
   * unit-status transition and any NOC auto-approval write.
   */
  @Post(':id/cancel')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_CANCEL)
  @ApiOperation({ summary: 'Cancel/surrender (deduction from master, computes refundable; blocked without an approved broker NOC)' })
  cancel(@Param('id') id: string, @Body() dto: CancellationDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return runWithTenant({ companyId: u.companyId }, () =>
      withTenantTx(this.tenantPrisma, u.companyId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id, companyId: u.companyId } });
        if (booking?.brokerId) {
          await this.nocs.assertApprovedOrAutoApprove(tx, u.companyId, id, booking.brokerId, u.sub);
        }
        const result = await this.cancellations.cancel(u.companyId, id, dto, u.sub);
        if (booking?.brokerId) {
          await this.commissions.handleBookingCancelled(u.companyId, result.event, booking.brokerId, u.sub);
        }
        return result;
      }),
    );
  }
}
