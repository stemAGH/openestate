import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createInventoryGroupSchema,
  updateInventoryGroupSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { InventoryGroupService } from './inventory-group.service';

class CreateInventoryGroupDto extends createZodDto(createInventoryGroupSchema) {}
class UpdateInventoryGroupDto extends createZodDto(updateInventoryGroupSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['code', 'name'] as const)) {}

// Bare @Controller() (no path prefix): list/create are project-scoped
// (plotted-farmhouse-inventory.md §8's GET/POST /projects/:id/inventory-groups),
// but edit/deactivate are addressed by the group's own id directly
// (PATCH/DELETE /inventory-groups/:id) — mirrors how a group is actually
// referenced elsewhere (Unit.inventoryGroupId, no project context
// needed to look one up once you have its id).
@ApiTags('Inventory Groups')
@Controller()
export class InventoryGroupController {
  constructor(private readonly groups: InventoryGroupService) {}

  @Get('projects/:projectId/inventory-groups')
  @RequirePermissions(PERMISSIONS.INVENTORY_INVENTORY_GROUP_MANAGE)
  @ApiOperation({ summary: 'List inventory groups (Sector/Block/Cluster) in a LAND_BASED project' })
  findAll(@Param('projectId') projectId: string, @Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.groups.findAll(user.companyId, projectId, query);
  }

  @Get('projects/:projectId/inventory-groups/:id')
  @RequirePermissions(PERMISSIONS.INVENTORY_INVENTORY_GROUP_MANAGE)
  @ApiOperation({ summary: 'Get an inventory group by ID' })
  findOne(@Param('projectId') projectId: string, @Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.groups.findOne(user.companyId, projectId, id);
  }

  @Post('projects/:projectId/inventory-groups')
  @RequirePermissions(PERMISSIONS.INVENTORY_INVENTORY_GROUP_MANAGE)
  @ApiOperation({ summary: 'Create an inventory group in a LAND_BASED project' })
  create(@Param('projectId') projectId: string, @Body() dto: CreateInventoryGroupDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.groups.create(user.companyId, projectId, dto);
  }

  @Patch('inventory-groups/:id')
  @RequirePermissions(PERMISSIONS.INVENTORY_INVENTORY_GROUP_MANAGE)
  @ApiOperation({ summary: 'Edit an inventory group' })
  update(@Param('id') id: string, @Body() dto: UpdateInventoryGroupDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.groups.update(user.companyId, id, dto);
  }

  @Delete('inventory-groups/:id')
  @RequirePermissions(PERMISSIONS.INVENTORY_INVENTORY_GROUP_MANAGE)
  @ApiOperation({ summary: 'Deactivate an inventory group (soft delete)' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.groups.remove(user.companyId, id);
  }
}
