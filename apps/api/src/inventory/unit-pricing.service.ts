import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import type { CreateUnitPlcDto, CreateUnitChargeDto } from '@openestate/shared';

/** UnitPlc + UnitCharge CRUD — near-identical shape, one service for both. */
@Injectable()
export class UnitPricingService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  listPlcs(companyId: string, unitId: string) {
    return this.systemPrisma.unitPlc.findMany({
      where: { companyId, unitId },
      include: { plcType: true },
    });
  }

  listCharges(companyId: string, unitId: string) {
    return this.systemPrisma.unitCharge.findMany({
      where: { companyId, unitId },
      include: { chargeType: true },
    });
  }

  addPlc(companyId: string, unitId: string, dto: CreateUnitPlcDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const unit = await tx.unit.findFirst({ where: { id: unitId, companyId } });
        if (!unit) throw new NotFoundException('Unit not found');
        await assertOwnedByCompany(tx, companyId, [['plcType', dto.plcTypeId, 'PLC type']]);

        // Snapshot: a percentage resolves to a paise amount once, right
        // now, off the unit's CURRENT base rate — never live-recomputed if
        // the rate changes later (matches every other snapshot in this
        // codebase: rate revisions, GST-on-cost-line, etc.).
        const amountPaise =
          dto.amountPaise ??
          (BigInt(unit.baseRatePaise) * BigInt(Math.round(dto.percentage! * 100))) / 10000n;

        return tx.unitPlc.create({
          data: {
            companyId,
            unitId,
            plcTypeId: dto.plcTypeId,
            amountPaise,
            percentage: dto.percentage,
          },
        });
      }),
    );
  }

  async removePlc(companyId: string, unitId: string, id: string) {
    const row = await this.systemPrisma.unitPlc.findFirst({ where: { id, unitId, companyId } });
    if (!row) throw new NotFoundException('Unit PLC not found');
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) => tx.unitPlc.delete({ where: { id } })),
    );
  }

  addCharge(companyId: string, unitId: string, dto: CreateUnitChargeDto) {
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const unit = await tx.unit.findFirst({ where: { id: unitId, companyId } });
        if (!unit) throw new NotFoundException('Unit not found');
        await assertOwnedByCompany(tx, companyId, [['chargeType', dto.chargeTypeId, 'Charge type']]);
        return tx.unitCharge.create({
          data: { companyId, unitId, chargeTypeId: dto.chargeTypeId, amountPaise: dto.amountPaise },
        });
      }),
    );
  }

  async removeCharge(companyId: string, unitId: string, id: string) {
    const row = await this.systemPrisma.unitCharge.findFirst({ where: { id, unitId, companyId } });
    if (!row) throw new NotFoundException('Unit charge not found');
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) => tx.unitCharge.delete({ where: { id } })),
    );
  }
}
