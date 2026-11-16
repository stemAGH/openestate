import {
  Body,
  Controller,
  Delete,
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
  createGstRateSchema,
  updateGstRateSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../../auth/guards/permissions.guard';
import { GstRateService } from './gst-rate.service';

class CreateGstRateDto extends createZodDto(createGstRateSchema) {}
class UpdateGstRateDto extends createZodDto(updateGstRateSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['sortOrder', 'rate', 'effectiveFrom'] as const)) {}

@ApiTags('GST Rates')
@Controller('masters/gst-rates')
export class GstRateController {
  constructor(private readonly gstRateService: GstRateService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'List GST rates' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.gstRateService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'Get GST rate by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.gstRateService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_CREATE)
  @ApiOperation({ summary: 'Create GST rate' })
  create(@Body() dto: CreateGstRateDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.gstRateService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_UPDATE)
  @ApiOperation({ summary: 'Update GST rate' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateGstRateDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.gstRateService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_DELETE)
  @ApiOperation({ summary: 'Delete GST rate' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.gstRateService.remove(user.companyId, id);
  }
}
