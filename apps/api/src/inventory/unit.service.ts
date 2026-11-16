import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { toAreaScaled, convertToSqftScaled, fromAreaScaled } from '@openestate/shared';
import type {
  CreateUnitDto,
  UpdateUnitDto,
  BulkGenerateUnitsDto,
  CreateLandBasedUnitDto,
  PaginationQuery,
} from '@openestate/shared';

@Injectable()
export class UnitService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly customFields: CustomFieldsService,
  ) {}

  async findAll(companyId: string, projectId: string, query: PaginationQuery & { towerId?: string; floorId?: string; status?: string; inventoryGroupId?: string }) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      companyId,
      // Unit.projectId (Phase A scalar), not floor.tower.projectId — the
      // old traversal returned zero rows for a LAND_BASED unit (floor is
      // null). See plotted-farmhouse-inventory.md §13.1.
      projectId,
    };
    if (query.towerId) {
      where.floor = { towerId: query.towerId };
    }
    if (query.floorId) {
      where.floorId = query.floorId;
    }
    if (query.inventoryGroupId) {
      where.inventoryGroupId = query.inventoryGroupId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (search) {
      where.number = { contains: search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.unit.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { number: 'asc' },
        include: {
          unitType: true,
          floor: { include: { tower: { select: { id: true, name: true, code: true } } } },
          // Nullable — HIGH_RISE units never have one, LAND_BASED units
          // may be ungrouped. See portal-property.service.ts for the
          // same null-checked pattern.
          inventoryGroup: { select: { id: true, name: true } },
        },
      }),
      this.systemPrisma.unit.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.unit.findFirst({
      where: { id, companyId },
      include: {
        unitType: true,
        floor: { include: { tower: { select: { id: true, name: true, code: true, projectId: true } } } },
        plcs: { include: { plcType: true } },
        charges: { include: { chargeType: true } },
        rateRevisions: { orderBy: { effectiveFrom: 'desc' }, take: 5 },
        statusChanges: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!item) throw new NotFoundException('Unit not found');
    return item;
  }

  async create(companyId: string, floorId: string, dto: CreateUnitDto) {
    const { customFields: incoming, ...rest } = dto;
    const customFields = await this.customFields.resolveValuesForWrite(
      companyId,
      'UNIT',
      incoming,
    );
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, [['unitType', rest.unitTypeId, 'Unit type']]);
        const floor = await tx.floor.findFirst({
          where: { id: floorId, companyId },
          include: { tower: { include: { project: { select: { shape: true } } } } },
        });
        if (!floor) throw new NotFoundException('Floor not found');
        // Structurally unreachable today (a tower can only exist under a
        // HIGH_RISE project — see TowerService.create's own guard — and
        // Project.shape is immutable per §13.3), but stated explicitly
        // per plotted-farmhouse-inventory.md §8 rather than left implicit.
        if (floor.tower.project.shape !== 'HIGH_RISE') {
          throw new BadRequestException(
            'This project is LAND_BASED. Use POST /projects/:id/units/land-based instead.',
          );
        }

        await this.validateTowerScopedUniqueness(tx, companyId, floor.tower.id, [rest.number]);

        return tx.unit.create({
          data: {
            ...rest,
            companyId,
            projectId: floor.tower.projectId,
            shape: 'HIGH_RISE',
            floorId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customFields: customFields as any,
          },
        });
      }),
    );
  }

  /**
   * Sibling to create() above, not a branch on it — a LAND_BASED unit has
   * no floor to be created "on", so a distinct route/DTO keeps validation
   * clean (plotted-farmhouse-inventory.md §8). floorId/inventoryGroupId
   * shape is enforced by the units_shape_hierarchy_chk CHECK constraint
   * at the DB level too — this is the belt to that suspenders.
   */
  async createLandBased(companyId: string, projectId: string, dto: CreateLandBasedUnitDto) {
    const { customFields: incoming, ...rest } = dto;
    const customFields = await this.customFields.resolveValuesForWrite(companyId, 'UNIT', incoming);

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const project = await tx.project.findFirst({ where: { id: projectId, companyId } });
        if (!project) throw new NotFoundException('Project not found');
        await assertOwnedByCompany(tx, companyId, [['unitType', rest.unitTypeId, 'Unit type']]);
        if (project.shape !== 'LAND_BASED') {
          throw new BadRequestException(
            'This project is HIGH_RISE. Use POST /projects/:id/units/floors/:floorId instead.',
          );
        }
        if (rest.inventoryGroupId) {
          const group = await tx.inventoryGroup.findFirst({ where: { id: rest.inventoryGroupId, companyId, projectId } });
          if (!group) throw new NotFoundException('Inventory group not found in this project');
        }

        // Project-scoped uniqueness — units_number_floor_id_key (the DB
        // constraint on [floorId, number]) gives ZERO protection here:
        // Postgres never treats two NULL floorId rows as equal, so every
        // LAND_BASED unit's number would otherwise be uncontested.
        const numberTaken = await tx.unit.findFirst({ where: { companyId, projectId, number: rest.number } });
        if (numberTaken) {
          throw new BadRequestException(`Unit number already exists in this project: ${rest.number}`);
        }

        // landAreaSqft is DERIVED, never accepted from the client — the
        // invariant landAreaSqft === convertToSqft(landAreaEntered,
        // landAreaEnteredUnit) is enforced by computing it here, not by
        // trusting a submitted value (§7.1).
        const enteredScaled = toAreaScaled(rest.landAreaEntered);
        const sqftScaled = convertToSqftScaled(enteredScaled, rest.landAreaEnteredUnit);

        return tx.unit.create({
          data: {
            ...rest,
            companyId,
            projectId,
            shape: 'LAND_BASED',
            floorId: null,
            landAreaSqft: fromAreaScaled(sqftScaled),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            customFields: customFields as any,
          },
        });
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateUnitDto) {
    const existing = await this.findOne(companyId, id);
    const { customFields: incoming, ...rest } = dto;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { ...rest };
    if (incoming !== undefined) {
      data.customFields = await this.customFields.resolveValuesForWrite(
        companyId,
        'UNIT',
        incoming,
        (existing as { customFields?: Record<string, unknown> | null }).customFields ?? null,
      );
    }
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, [['unitType', (rest as { unitTypeId?: string | null }).unitTypeId, 'Unit type']]);
        return tx.unit.update({ where: { id }, data });
      }),
    );
  }

  async bulkGenerate(companyId: string, projectId: string, dto: BulkGenerateUnitsDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const tower = await tx.tower.findFirst({
          where: { id: dto.towerId, companyId, projectId },
        });
        if (!tower) throw new NotFoundException('Tower not found in project');
        await assertOwnedByCompany(tx, companyId, [['unitType', dto.unitTypeId, 'Unit type']]);

        const unitNumbers: string[] = [];
        const floorData: Array<{ floorNumber: number; name: string }> = [];

        for (let f = dto.floorStart; f <= dto.floorEnd; f++) {
          floorData.push({ floorNumber: f, name: `Floor ${f}` });
          for (let u = 1; u <= dto.unitsPerFloor; u++) {
            const unitNum = `${dto.unitPrefix}${String(f).padStart(2, '0')}${String(u).padStart(2, '0')}`;
            unitNumbers.push(unitNum);
          }
        }

        await this.validateTowerScopedUniqueness(tx, companyId, dto.towerId, unitNumbers);

        let createdCount = 0;
        for (const fd of floorData) {
          const floor = await tx.floor.upsert({
            where: {
              towerId_floorNumber: { towerId: dto.towerId, floorNumber: fd.floorNumber },
            },
            update: {},
            create: {
              companyId,
              towerId: dto.towerId,
              name: fd.name,
              floorNumber: fd.floorNumber,
            },
          });

          for (let u = 1; u <= dto.unitsPerFloor; u++) {
            const unitNum = `${dto.unitPrefix}${String(fd.floorNumber).padStart(2, '0')}${String(u).padStart(2, '0')}`;
            await tx.unit.create({
              data: {
                companyId,
                projectId: tower.projectId,
                shape: 'HIGH_RISE',
                floorId: floor.id,
                number: unitNum,
                unitTypeId: dto.unitTypeId ?? null,
                carpetAreaSqft: dto.carpetAreaSqft ?? null,
                builtUpAreaSqft: dto.builtUpAreaSqft ?? null,
                superBuiltUpSqft: dto.superBuiltUpSqft ?? null,
                baseRatePaise: dto.baseRatePaise,
              },
            });
            createdCount++;
          }
        }

        return { createdCount, towerCode: tower.code };
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async validateTowerScopedUniqueness(tx: any, companyId: string, towerId: string, unitNumbers: string[]) {
    const existing = await tx.unit.findMany({
      where: {
        companyId,
        floor: { towerId },
        number: { in: unitNumbers },
      },
      select: { number: true },
    });

    if (existing.length > 0) {
      const dupes = existing.map((u: { number: string }) => u.number);
      throw new BadRequestException(
        `Unit numbers already exist in this tower: ${dupes.join(', ')}`,
      );
    }

    const seen = new Set<string>();
    const inputDupes: string[] = [];
    for (const num of unitNumbers) {
      if (seen.has(num)) inputDupes.push(num);
      seen.add(num);
    }
    if (inputDupes.length > 0) {
      throw new BadRequestException(
        `Duplicate unit numbers in request: ${inputDupes.join(', ')}`,
      );
    }
  }
}
