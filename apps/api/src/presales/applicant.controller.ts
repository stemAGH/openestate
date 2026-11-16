import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { PrismaClient } from '@openestate/db';
import {
  createApplicantSchema,
  updateApplicantSchema,
  recordConsentSchema,
  confirmDistinctSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { SYSTEM_PRISMA } from '../database/database.module';
import { ApplicantService } from './applicant.service';

class CreateApplicantDto extends createZodDto(createApplicantSchema) {}
class UpdateApplicantDto extends createZodDto(updateApplicantSchema) {}
class RecordConsentDto extends createZodDto(recordConsentSchema) {}
class ConfirmDistinctDto extends createZodDto(confirmDistinctSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['name'] as const)) {}

@ApiTags('Applicants')
@Controller('applicants')
export class ApplicantController {
  constructor(
    private readonly applicantService: ApplicantService,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'List applicants' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Get applicant by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_CREATE)
  @ApiOperation({ summary: 'Create applicant (returns possibleDuplicateApplicantIds)' })
  create(@Body() dto: CreateApplicantDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_UPDATE)
  @ApiOperation({ summary: 'Update applicant' })
  update(@Param('id') id: string, @Body() dto: UpdateApplicantDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.update(user.companyId, id, dto);
  }

  @Get(':id/consent')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Full consent history (append-only ledger)' })
  consentHistory(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.getConsentHistory(user.companyId, id);
  }

  @Get(':id/consent/current')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Current consent (latest ledger row)' })
  currentConsent(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.getCurrentConsent(user.companyId, id);
  }

  @Post(':id/consent')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_UPDATE)
  @ApiOperation({ summary: 'Record a consent event (grant or revoke)' })
  recordConsent(
    @Param('id') id: string,
    @Body() dto: RecordConsentDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.applicantService.recordConsent(
      user.companyId,
      id,
      user.sub,
      dto.given,
      dto.source,
    );
  }

  @Get(':id/communications')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Communication timeline, including merged-in applicants' })
  communications(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.getCommunicationTimeline(user.companyId, id);
  }

  @Get(':id/360')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Applicant 360°: bookings, inquiries + follow-ups, documents, dispatch history' })
  async threeSixty(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const applicant = await this.systemPrisma.applicant.findFirst({ where: { id, companyId: user.companyId } });
    if (!applicant) throw new NotFoundException('Applicant not found');

    const [bookings, inquiries, documents, dispatches] = await Promise.all([
      this.systemPrisma.booking.findMany({
        where: {
          companyId: user.companyId,
          OR: [{ primaryApplicantId: id }, { coApplicants: { some: { applicantId: id } } }],
        },
        include: { unit: { include: { floor: { include: { tower: true } } } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.systemPrisma.inquiry.findMany({
        where: { companyId: user.companyId, applicantId: id },
        include: { followUps: { orderBy: { createdAt: 'desc' } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.systemPrisma.generatedDocument.findMany({
        where: { companyId: user.companyId, applicantId: id },
        orderBy: { createdAt: 'desc' },
      }),
      this.systemPrisma.documentDispatch.findMany({
        where: { companyId: user.companyId, applicantId: id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { applicant, bookings, inquiries, documents, dispatches };
  }

  @Get(':id/duplicates')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_READ)
  @ApiOperation({ summary: 'Re-check for duplicate candidates, excluding confirmed-distinct pairs' })
  duplicates(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.applicantService.findDuplicatesForApplicant(user.companyId, id);
  }

  @Post(':id/confirm-distinct')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_MERGE)
  @ApiOperation({ summary: 'Record that this applicant and another are confirmed to be different people' })
  confirmDistinct(
    @Param('id') id: string,
    @Body() dto: ConfirmDistinctDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.applicantService.confirmDistinct(
      user.companyId,
      id,
      dto.otherApplicantId,
      user.sub,
    );
  }

  @Post(':survivorId/merge/:mergedId')
  @RequirePermissions(PERMISSIONS.PRESALES_APPLICANT_MERGE)
  @ApiOperation({ summary: 'Merge a duplicate applicant into a survivor' })
  merge(
    @Param('survivorId') survivorId: string,
    @Param('mergedId') mergedId: string,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.applicantService.merge(user.companyId, survivorId, mergedId, user.sub);
  }
}
