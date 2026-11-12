import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createLetterTemplateSchema,
  updateLetterTemplateSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../../auth/guards/permissions.guard';
import { LetterTemplateService } from './letter-template.service';

class CreateLetterTemplateDto extends createZodDto(createLetterTemplateSchema) {}
class UpdateLetterTemplateDto extends createZodDto(updateLetterTemplateSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['sortOrder', 'name'] as const)) {}

@ApiTags('Letter Templates')
@Controller('masters/letter-templates')
export class LetterTemplateController {
  constructor(private readonly letterTemplateService: LetterTemplateService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'List letter templates' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.letterTemplateService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
  @ApiOperation({ summary: 'Get letter template by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.letterTemplateService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_CREATE)
  @ApiOperation({ summary: 'Create letter template (merge fields validated against the document type)' })
  create(@Body() dto: CreateLetterTemplateDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.letterTemplateService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_UPDATE)
  @ApiOperation({ summary: 'Update letter template' })
  update(@Param('id') id: string, @Body() dto: UpdateLetterTemplateDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.letterTemplateService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_MASTER_DELETE)
  @ApiOperation({ summary: 'Delete letter template' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.letterTemplateService.remove(user.companyId, id);
  }
}
