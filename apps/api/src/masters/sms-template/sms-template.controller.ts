import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createSmsTemplateSchema,
  updateSmsTemplateSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../../auth/guards/permissions.guard';
import { SmsTemplateService } from './sms-template.service';

class CreateSmsTemplateDto extends createZodDto(createSmsTemplateSchema) {}
class UpdateSmsTemplateDto extends createZodDto(updateSmsTemplateSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['sortOrder', 'name'] as const)) {}

@ApiTags('SMS Templates')
@Controller('masters/sms-templates')
export class SmsTemplateController {
  constructor(private readonly smsTemplateService: SmsTemplateService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'List SMS templates' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.smsTemplateService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'Get SMS template by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.smsTemplateService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_CREATE)
  @ApiOperation({ summary: 'Create SMS template (DLT fields required)' })
  create(@Body() dto: CreateSmsTemplateDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.smsTemplateService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_UPDATE)
  @ApiOperation({ summary: 'Update SMS template' })
  update(@Param('id') id: string, @Body() dto: UpdateSmsTemplateDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.smsTemplateService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_DELETE)
  @ApiOperation({ summary: 'Delete SMS template' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.smsTemplateService.remove(user.companyId, id);
  }
}
