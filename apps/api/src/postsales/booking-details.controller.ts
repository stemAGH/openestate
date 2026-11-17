import { Body, Controller, Delete, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PERMISSIONS, hasNoNul, NO_NUL_MESSAGE, type JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { TeamScopeService } from '../team-scope/team-scope.service';
import { BookingDetailsService } from './booking-details.service';
import { bookingScope } from './booking-list.service';

export const bookingRemarkSchema = z
  .object({ remark: z.string().max(1000).refine(hasNoNul, NO_NUL_MESSAGE).nullable() })
  .strict();
export const addCoApplicantSchema = z
  .object({
    applicantId: z.string().uuid(),
    // The screen states that the person's portal account will see this booking.
    confirmPortalAccess: z.literal(true),
  })
  .strict();
export const reorderCoApplicantsSchema = z.object({ applicantIds: z.array(z.string().uuid()).min(1).max(20) }).strict();
class BookingRemarkDto extends createZodDto(bookingRemarkSchema) {}
class AddCoApplicantDto extends createZodDto(addCoApplicantSchema) {}
class ReorderCoApplicantsDto extends createZodDto(reorderCoApplicantsSchema) {}

/** Non-financial booking edits (Plan D). Scope as the bookings list; closed bookings refused. */
@ApiTags('Bookings')
@Controller('bookings')
export class BookingDetailsController {
  constructor(
    private readonly details: BookingDetailsService,
    private readonly teamScope: TeamScopeService,
  ) {}

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_UPDATE)
  @ApiOperation({ summary: "Set or clear the booking's remark (non-financial)" })
  async setRemark(@Param('id') id: string, @Body() dto: BookingRemarkDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.details.setRemark(u, id, dto.remark, await bookingScope(this.teamScope, u));
  }

  @Post(':id/co-applicants')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_UPDATE)
  @ApiOperation({ summary: "Add a co-applicant (their portal account can then see the booking; requires confirmPortalAccess: true)" })
  async addCoApplicant(@Param('id') id: string, @Body() dto: AddCoApplicantDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.details.addCoApplicant(u, id, dto.applicantId, await bookingScope(this.teamScope, u));
  }

  @Delete(':id/co-applicants/:applicantId')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_UPDATE)
  @ApiOperation({ summary: 'Remove a co-applicant (their portal account no longer sees the booking)' })
  async removeCoApplicant(@Param('id') id: string, @Param('applicantId') applicantId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.details.removeCoApplicant(u, id, applicantId, await bookingScope(this.teamScope, u));
  }

  @Put(':id/co-applicants/order')
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_UPDATE)
  @ApiOperation({ summary: 'Reorder co-applicants (every current co-applicant, once)' })
  async reorder(@Param('id') id: string, @Body() dto: ReorderCoApplicantsDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.details.reorderCoApplicants(u, id, dto.applicantIds, await bookingScope(this.teamScope, u));
  }
}
