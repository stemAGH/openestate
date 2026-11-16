import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  COMMISSION_TYPE,
  validateSlabContiguity,
  type CreateCommissionRuleDto,
  type UpdateCommissionRuleDto,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';

@Injectable()
export class BrokerCommissionRuleService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findAllForBroker(companyId: string, brokerId: string) {
    return this.systemPrisma.brokerCommissionRule.findMany({
      where: { companyId, brokerId },
      include: { slabs: { orderBy: { seq: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(companyId: string, id: string) {
    const rule = await this.systemPrisma.brokerCommissionRule.findFirst({
      where: { id, companyId },
      include: { slabs: { orderBy: { seq: 'asc' } } },
    });
    if (!rule) throw new NotFoundException('Commission rule not found');
    return rule;
  }

  /**
   * The applicable rule for a booking: project-specific override first,
   * falling back to the broker's company-wide default (projectId=null).
   */
  async findApplicableRule(companyId: string, brokerId: string, projectId: string) {
    const projectRule = await this.systemPrisma.brokerCommissionRule.findFirst({
      where: { companyId, brokerId, projectId, isActive: true },
      include: { slabs: { orderBy: { seq: 'asc' } } },
    });
    if (projectRule) return projectRule;

    return this.systemPrisma.brokerCommissionRule.findFirst({
      where: { companyId, brokerId, projectId: null, isActive: true },
      include: { slabs: { orderBy: { seq: 'asc' } } },
    });
  }

  async create(companyId: string, dto: CreateCommissionRuleDto) {
    const broker = await this.systemPrisma.broker.findFirst({ where: { id: dto.brokerId, companyId } });
    if (!broker) throw new NotFoundException('Broker not found');

    if (dto.commissionType === COMMISSION_TYPE.SLAB) {
      const check = validateSlabContiguity(dto.slabs ?? []);
      if (!check.valid) throw new BadRequestException(check.error);
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, [
          ['broker', dto.brokerId, 'Broker'],
          ['project', dto.projectId, 'Project'],
        ]);
        const rule = await tx.brokerCommissionRule.create({
          data: {
            companyId,
            brokerId: dto.brokerId,
            projectId: dto.projectId ?? null,
            commissionType: dto.commissionType,
            flatPercent: dto.flatPercent,
            flatPaise: dto.flatPaise,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            milestonesJson: (dto.milestones ?? null) as any,
          },
        });
        if (dto.commissionType === COMMISSION_TYPE.SLAB && dto.slabs) {
          await tx.brokerCommissionSlab.createMany({
            data: dto.slabs.map((s) => ({
              companyId,
              ruleId: rule.id,
              seq: s.seq,
              fromPaise: s.fromPaise,
              toPaise: s.toPaise ?? null,
              ratePercent: s.ratePercent,
            })),
          });
        }
        return tx.brokerCommissionRule.findFirst({ where: { id: rule.id }, include: { slabs: true } });
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateCommissionRuleDto) {
    const existing = await this.findOne(companyId, id);
    const merged = { ...existing, ...dto };

    if (merged.commissionType === COMMISSION_TYPE.SLAB && dto.slabs) {
      const check = validateSlabContiguity(dto.slabs);
      if (!check.valid) throw new BadRequestException(check.error);
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = {};
        if (dto.projectId !== undefined) data.projectId = dto.projectId;
        if (dto.commissionType !== undefined) data.commissionType = dto.commissionType;
        if (dto.flatPercent !== undefined) data.flatPercent = dto.flatPercent;
        if (dto.flatPaise !== undefined) data.flatPaise = dto.flatPaise;
        if (dto.milestones !== undefined) data.milestonesJson = dto.milestones;

        await tx.brokerCommissionRule.update({ where: { id }, data });

        if (dto.slabs) {
          await tx.brokerCommissionSlab.deleteMany({ where: { ruleId: id } });
          await tx.brokerCommissionSlab.createMany({
            data: dto.slabs.map((s) => ({
              companyId,
              ruleId: id,
              seq: s.seq,
              fromPaise: s.fromPaise,
              toPaise: s.toPaise ?? null,
              ratePercent: s.ratePercent,
            })),
          });
        }
        return tx.brokerCommissionRule.findFirst({ where: { id }, include: { slabs: true } });
      }),
    );
  }

  async deactivate(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) => tx.brokerCommissionRule.update({ where: { id }, data: { isActive: false } })),
    );
  }
}
