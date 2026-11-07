import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Request } from 'express';
import { PERMISSIONS, raiseStageSchema } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { StageRaiseService } from './stage-raise.service';

class RaiseStageDto extends createZodDto(raiseStageSchema) {}

/**
 * Bulk per-project-stage demand raising. See
 * internal plan construction-linked-demand-fix.md §1.5/§6.1. Mounted under
 * /projects — a project-scoped resource — even though StageRaiseService
 * lives in the postsales module, since it writes Installment/PaymentPlan
 * rows that module owns; NestJS controllers route independently of their
 * declaring module.
 */
@ApiTags('Projects')
@Controller('projects/:projectId/stage-raises')
export class StageRaiseController {
  constructor(private readonly stageRaises: StageRaiseService) {}

  @Post()
  @RequirePermissions(PERMISSIONS.POSTSALES_DEMAND_RAISE)
  @ApiOperation({ summary: 'Mark a construction stage complete and raise demands for every eligible booking in this project' })
  raise(@Param('projectId') projectId: string, @Body() dto: RaiseStageDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.stageRaises.raiseStage(u.companyId, projectId, dto, u.sub);
  }

  @Get('pending')
  @RequirePermissions(PERMISSIONS.POSTSALES_DEMAND_RAISE)
  @ApiOperation({ summary: 'Distinct STAGE_LINKED milestones currently unraised in this project, with pending-booking counts' })
  pending(@Param('projectId') projectId: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.stageRaises.listPending(u.companyId, projectId);
  }
}
