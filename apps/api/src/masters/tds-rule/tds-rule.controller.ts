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
  createTdsRuleSchema,
  updateTdsRuleSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../../auth/guards/permissions.guard';
import { TdsRuleService } from './tds-rule.service';

class CreateTdsRuleDto extends createZodDto(createTdsRuleSchema) {}
class UpdateTdsRuleDto extends createZodDto(updateTdsRuleSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['sortOrder', 'section', 'effectiveFrom'] as const)) {}

@ApiTags('TDS Rules')
@Controller('masters/tds-rules')
export class TdsRuleController {
  constructor(private readonly tdsRuleService: TdsRuleService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'List TDS rules' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tdsRuleService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'Get TDS rule by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tdsRuleService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_CREATE)
  @ApiOperation({ summary: 'Create TDS rule' })
  create(@Body() dto: CreateTdsRuleDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tdsRuleService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_UPDATE)
  @ApiOperation({ summary: 'Update TDS rule' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTdsRuleDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.tdsRuleService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_DELETE)
  @ApiOperation({ summary: 'Delete TDS rule' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.tdsRuleService.remove(user.companyId, id);
  }
}
