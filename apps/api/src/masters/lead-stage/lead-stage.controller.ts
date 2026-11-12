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
  createLeadStageSchema,
  updateLeadStageSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../../auth/guards/permissions.guard';
import { LeadStageService } from './lead-stage.service';

class CreateLeadStageDto extends createZodDto(createLeadStageSchema) {}
class UpdateLeadStageDto extends createZodDto(updateLeadStageSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['sortOrder', 'name'] as const)) {}

@ApiTags('Lead Stages')
@Controller('masters/lead-stages')
export class LeadStageController {
  constructor(private readonly leadStageService: LeadStageService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'List lead stages' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.leadStageService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'Get lead stage by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.leadStageService.findOne(user.companyId, id);
  }

  @Get(':id/occupancy')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'Count of active (OPEN/CONTINUED) inquiries currently at this stage' })
  occupancy(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.leadStageService.occupancy(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_CREATE)
  @ApiOperation({ summary: 'Create lead stage' })
  create(@Body() dto: CreateLeadStageDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.leadStageService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_UPDATE)
  @ApiOperation({
    summary: 'Update lead stage — deactivating an occupied stage requires reassignToStageId',
  })
  update(@Param('id') id: string, @Body() dto: UpdateLeadStageDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.leadStageService.update(user.companyId, id, dto, user.sub);
  }

  // No DELETE route — deactivation (PATCH isActive:false) is the only way
  // to retire a stage. See LeadStageService's own comment for why.
}
