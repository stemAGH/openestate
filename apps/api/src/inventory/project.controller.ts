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
  createProjectSchema,
  updateProjectSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ProjectService } from './project.service';

class CreateProjectDto extends createZodDto(createProjectSchema) {}
class UpdateProjectDto extends createZodDto(updateProjectSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['name', 'code'] as const)) {}

@ApiTags('Projects')
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INVENTORY_PROJECT_READ)
  @ApiOperation({ summary: 'List projects' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.projectService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_PROJECT_READ)
  @ApiOperation({ summary: 'Get project by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.projectService.findOne(user.companyId, id);
  }

  @Get(':id/booking-count')
  @RequirePermissions(PERMISSIONS.INVENTORY_PROJECT_READ)
  @ApiOperation({ summary: 'Count bookings under this project (for edit-form warnings)' })
  bookingCount(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.projectService.bookingCount(user.companyId, id).then((count) => ({ count }));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.INVENTORY_PROJECT_CREATE)
  @ApiOperation({ summary: 'Create project' })
  create(@Body() dto: CreateProjectDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.projectService.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_PROJECT_UPDATE)
  @ApiOperation({ summary: 'Update project' })
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.projectService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_PROJECT_DELETE)
  @ApiOperation({ summary: 'Delete project' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.projectService.remove(user.companyId, id);
  }
}
