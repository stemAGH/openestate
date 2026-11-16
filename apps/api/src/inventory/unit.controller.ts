import { z } from 'zod';
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
  createUnitSchema,
  updateUnitSchema,
  bulkGenerateUnitsSchema,
  unitStatusTransitionSchema,
  changeRateSchema,
  createUnitPlcSchema,
  createUnitChargeSchema,
  createLandBasedUnitSchema,
  paginationQuerySchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { UnitService } from './unit.service';
import { UnitStateMachineService } from './unit-state-machine.service';
import { RateRevisionService } from './rate-revision.service';
import { UnitPricingService } from './unit-pricing.service';

class CreateUnitDto extends createZodDto(createUnitSchema) {}
class UpdateUnitDto extends createZodDto(updateUnitSchema) {}
class BulkGenerateUnitsDto extends createZodDto(bulkGenerateUnitsSchema) {}
class UnitStatusTransitionDto extends createZodDto(unitStatusTransitionSchema) {}
class ChangeRateDto extends createZodDto(changeRateSchema) {}
class CreateUnitPlcDto extends createZodDto(createUnitPlcSchema) {}
class CreateUnitChargeDto extends createZodDto(createUnitChargeSchema) {}
class CreateLandBasedUnitDto extends createZodDto(createLandBasedUnitSchema) {}
class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}
const emptyAsAbsent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
// The unit list: sortable by unit number only; its filters are declared so the schema can be strict.
class UnitListQueryDto extends createZodDto(
  sortableListQuerySchema(['number'] as const, {
    // An empty value ("?towerId=") means no filter, as before.
    towerId: emptyAsAbsent(z.string().uuid()),
    floorId: emptyAsAbsent(z.string().uuid()),
    inventoryGroupId: emptyAsAbsent(z.string().uuid()),
    status: emptyAsAbsent(z.string().max(40)),
  }),
) {}

@ApiTags('Units')
@Controller('projects/:projectId/units')
export class UnitController {
  constructor(
    private readonly unitService: UnitService,
    private readonly stateMachine: UnitStateMachineService,
    private readonly rateService: RateRevisionService,
    private readonly pricingService: UnitPricingService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'List units in a project' })
  findAll(
    @Param('projectId') projectId: string,
    @Query() query: UnitListQueryDto,
    @Query('towerId') towerId: string | undefined,
    @Query('floorId') floorId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('inventoryGroupId') inventoryGroupId: string | undefined,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.findAll(user.companyId, projectId, { ...query, towerId, floorId, status, inventoryGroupId });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'Get unit by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.unitService.findOne(user.companyId, id);
  }

  @Post('floors/:floorId')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_CREATE)
  @ApiOperation({ summary: 'Create unit on a floor' })
  create(
    @Param('floorId') floorId: string,
    @Body() dto: CreateUnitDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.create(user.companyId, floorId, dto);
  }

  @Post('land-based')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_CREATE)
  @ApiOperation({ summary: 'Create a LAND_BASED unit (plot) directly on a project — no floor' })
  createLandBased(
    @Param('projectId') projectId: string,
    @Body() dto: CreateLandBasedUnitDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.createLandBased(user.companyId, projectId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_UPDATE)
  @ApiOperation({ summary: 'Update unit' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUnitDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.update(user.companyId, id, dto);
  }

  @Post('bulk-generate')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_BULK_GENERATE)
  @ApiOperation({ summary: 'Bulk generate units for a tower' })
  bulkGenerate(
    @Param('projectId') projectId: string,
    @Body() dto: BulkGenerateUnitsDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.unitService.bulkGenerate(user.companyId, projectId, dto);
  }

  @Post(':id/transition')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_HOLD)
  @ApiOperation({
    summary:
      'Manually transition unit status (holds/blocks only; booking-lifecycle statuses are system-only)',
  })
  transition(
    @Param('id') id: string,
    @Body() dto: UnitStatusTransitionDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.stateMachine.transition(
      user.companyId,
      id,
      dto.toStatus,
      'user',
      user.sub,
      dto.reason,
    );
  }

  @Post('change-rate')
  @RequirePermissions(PERMISSIONS.INVENTORY_RATE_CHANGE)
  @ApiOperation({ summary: 'Change rate for multiple units' })
  changeRate(
    @Param('projectId') projectId: string,
    @Body() dto: ChangeRateDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.rateService.changeRate(user.companyId, projectId, dto, user.sub);
  }

  @Get(':id/rate-history')
  @RequirePermissions(PERMISSIONS.INVENTORY_RATE_READ)
  @ApiOperation({ summary: 'Get rate revision history for a unit' })
  rateHistory(
    @Param('id') id: string,
    @Query() query: PaginationQueryDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.rateService.getRateHistory(user.companyId, id, query);
  }

  @Get(':id/plcs')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'List PLCs assigned to a unit' })
  listPlcs(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pricingService.listPlcs(user.companyId, id);
  }

  @Post(':id/plcs')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE)
  @ApiOperation({ summary: 'Assign a PLC to a unit (snapshots amount from a % if given)' })
  addPlc(@Param('id') id: string, @Body() dto: CreateUnitPlcDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pricingService.addPlc(user.companyId, id, dto);
  }

  @Delete(':id/plcs/:plcId')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_PLC_MANAGE)
  @ApiOperation({ summary: 'Remove a PLC from a unit' })
  removePlc(@Param('id') id: string, @Param('plcId') plcId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pricingService.removePlc(user.companyId, id, plcId);
  }

  @Get(':id/charges')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_READ)
  @ApiOperation({ summary: 'List extra charges assigned to a unit' })
  listCharges(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pricingService.listCharges(user.companyId, id);
  }

  @Post(':id/charges')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_CHARGE_MANAGE)
  @ApiOperation({ summary: 'Assign an extra charge to a unit' })
  addCharge(@Param('id') id: string, @Body() dto: CreateUnitChargeDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pricingService.addCharge(user.companyId, id, dto);
  }

  @Delete(':id/charges/:chargeId')
  @RequirePermissions(PERMISSIONS.INVENTORY_UNIT_CHARGE_MANAGE)
  @ApiOperation({ summary: 'Remove an extra charge from a unit' })
  removeCharge(@Param('id') id: string, @Param('chargeId') chargeId: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.pricingService.removeCharge(user.companyId, id, chargeId);
  }
}
