import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PERMISSIONS, sortableListQuerySchema, type JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { TeamScopeService } from '../team-scope/team-scope.service';
import { BookingListService, bookingScope } from './booking-list.service';

const BOOKING_STATUSES = ['APPLICATION', 'BOOKED', 'ALLOTTED', 'REGISTERED', 'CANCELLED', 'SURRENDERED', 'TRANSFERRED_OUT'] as const;

export const bookingListQuerySchema = sortableListQuerySchema(['bookingNumber', 'bookingDate', 'status'] as const, {
  status: z.enum(BOOKING_STATUSES).optional(),
  projectId: z.string().uuid().optional(),
  towerId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
class BookingListQueryDto extends createZodDto(bookingListQuerySchema) {}

@ApiTags('Bookings')
@Controller('bookings')
export class BookingListController {
  constructor(
    private readonly list: BookingListService,
    private readonly teamScope: TeamScopeService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.POSTSALES_BOOKING_READ)
  @ApiOperation({
    summary: 'List bookings with the outstanding balance',
    description:
      'Search by booking number, applicant name or phone digits; filter by status, project, tower and booking date (from/to). ' +
      "Sales roles see bookings their team created; admin.team-scope.all or reports.postsales.company-wide sees the whole company. Phones masked.",
  })
  async findAll(@Query() query: BookingListQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.list.list(u.companyId, query, await bookingScope(this.teamScope, u));
  }
}
