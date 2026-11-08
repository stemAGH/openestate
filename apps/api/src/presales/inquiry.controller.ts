import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createInquirySchema,
  updateInquirySchema,
  assignInquirySchema,
  inquiryListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { InquiryService, type InquiryScope } from './inquiry.service';
import { TeamScopeService } from '../team-scope/team-scope.service';

class CreateInquiryDto extends createZodDto(createInquirySchema) {}
class UpdateInquiryDto extends createZodDto(updateInquirySchema) {}
class AssignInquiryDto extends createZodDto(assignInquirySchema) {}
class InquiryListQueryDto extends createZodDto(inquiryListQuerySchema) {}

@ApiTags('Inquiries')
@Controller('inquiries')
export class InquiryController {
  constructor(
    private readonly inquiryService: InquiryService,
    private readonly teamScope: TeamScopeService,
  ) {}

  private async scopeFor(user: JwtPayload): Promise<InquiryScope> {
    const visibleUserIds = await this.teamScope.getVisibleUserIds(
      user.companyId,
      user.sub,
      user.permissions,
    );
    return { visibleUserIds };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({
    summary: "List inquiries (scoped to the caller's reporting subtree)",
    description:
      'Search by applicant name, email or phone; filter by status (comma-separated), temperatureId, projectId, assignedToId (never widens the caller\'s team scope) and followUp=today|overdue (IST calendar day, active leads only). sortBy: createdAt or nextFollowupAt.',
  })
  async findAll(@Query() query: InquiryListQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.findAll(user.companyId, query, await this.scopeFor(user));
  }

  @Get('my-day')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: "Today's and overdue follow-ups assigned to me" })
  myDay(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.myDay(user.companyId, user.sub);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_READ)
  @ApiOperation({ summary: 'Get inquiry by ID' })
  async findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.findOne(user.companyId, id, await this.scopeFor(user));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_CREATE)
  @ApiOperation({ summary: 'Create inquiry (dedup-checks/links applicant, auto-assigns if project pool configured)' })
  create(@Body() dto: CreateInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.create(user.companyId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_UPDATE)
  @ApiOperation({ summary: 'Update inquiry' })
  async update(@Param('id') id: string, @Body() dto: UpdateInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.update(user.companyId, id, dto, await this.scopeFor(user), user.sub);
  }

  @Patch(':id/assign')
  @RequirePermissions(PERMISSIONS.PRESALES_INQUIRY_ASSIGN)
  @ApiOperation({ summary: 'Manually reassign an inquiry (both the inquiry and the target user must be in the caller\'s visible set)' })
  async assign(@Param('id') id: string, @Body() dto: AssignInquiryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.inquiryService.assign(
      user.companyId,
      id,
      dto.toUserId,
      user.sub,
      dto.reason,
      await this.scopeFor(user),
    );
  }
}
