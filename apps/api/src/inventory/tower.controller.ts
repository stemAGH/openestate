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
  createTowerSchema,
  updateTowerSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { TowerService } from './tower.service';

class CreateTowerDto extends createZodDto(createTowerSchema) {}
class UpdateTowerDto extends createZodDto(updateTowerSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['code', 'name'] as const)) {}

@ApiTags('Towers')
@Controller('projects/:projectId/towers')
export class TowerController {
  constructor(private readonly towerService: TowerService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INVENTORY_TOWER_READ)
  @ApiOperation({ summary: 'List towers in a project' })
  findAll(
    @Param('projectId') projectId: string,
    @Query() query: PaginationQueryDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.towerService.findAll(user.companyId, projectId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_TOWER_READ)
  @ApiOperation({ summary: 'Get tower by ID' })
  findOne(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.towerService.findOne(user.companyId, projectId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.INVENTORY_TOWER_CREATE)
  @ApiOperation({ summary: 'Create tower in a project' })
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateTowerDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.towerService.create(user.companyId, projectId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_TOWER_UPDATE)
  @ApiOperation({ summary: 'Update tower' })
  update(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTowerDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.towerService.update(user.companyId, projectId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_TOWER_DELETE)
  @ApiOperation({ summary: 'Delete tower' })
  remove(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.towerService.remove(user.companyId, projectId, id);
  }
}
