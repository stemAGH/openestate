import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import type {
  CreateProjectDto,
  UpdateProjectDto,
  PaginationQuery,
} from '@openestate/shared';

/** The ids a project write may name; each must be the caller's company's own. */
function projectRefs(dto: { projectTypeId?: string | null; areaLocationId?: string | null }) {
  return [
    ['projectType', dto.projectTypeId, 'Project type'],
    ['areaLocation', dto.areaLocationId, 'Area/location'],
  ] as Array<[string, string | null | undefined, string]>;
}

@Injectable()
export class ProjectService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly customFields: CustomFieldsService,
  ) {}

  async findAll(companyId: string, query: PaginationQuery) {
    const { page, limit, search, sortBy, sortOrder } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.systemPrisma.project.findMany({
        where,
        skip,
        take: limit,
        orderBy: sortBy ? { [sortBy]: sortOrder } : { createdAt: 'desc' },
        include: { projectType: true, areaLocation: true, _count: { select: { towers: true } } },
      }),
      this.systemPrisma.project.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(companyId: string, id: string) {
    const item = await this.systemPrisma.project.findFirst({
      where: { id, companyId },
      include: {
        projectType: true,
        areaLocation: true,
        towers: { include: { _count: { select: { floors: true } } } },
      },
    });
    if (!item) throw new NotFoundException('Project not found');
    return item;
  }

  async create(companyId: string, dto: CreateProjectDto) {
    const { customFields: incoming, ...rest } = dto;
    const customFields = await this.customFields.resolveValuesForWrite(
      companyId,
      'PROJECT',
      incoming,
    );
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, projectRefs(rest));
        return tx.project.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { ...rest, companyId, customFields: customFields as any },
        });
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateProjectDto) {
    const existing = await this.findOne(companyId, id);
    const { customFields: incoming, ...rest } = dto;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { ...rest };
    if (incoming !== undefined) {
      data.customFields = await this.customFields.resolveValuesForWrite(
        companyId,
        'PROJECT',
        incoming,
        (existing as { customFields?: Record<string, unknown> | null }).customFields ?? null,
      );
    }
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        await assertOwnedByCompany(tx, companyId, projectRefs(rest));
        return tx.project.update({ where: { id }, data });
      }),
    );
  }

  // Cheap existence-style count for the frontend's areaLocationId-change
  // confirmation dialog. Only ever called for one project at a time from
  // the edit form, not a list endpoint. Joins via Unit.projectId (Phase A
  // scalar) — the old floor.tower.projectId traversal always undercounted
  // (silently zero) for a LAND_BASED project's bookings. See
  // plotted-farmhouse-inventory.md §13.1.
  async bookingCount(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.booking.count({ where: { unit: { projectId: id } } }),
      ),
    );
  }

  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.project.delete({ where: { id } }),
      ),
    );
  }
}
