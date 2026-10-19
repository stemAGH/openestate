import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createMasterSchema,
  updateMasterSchema,
  paginationQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload, PaginationQuery } from '@openestate/shared';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { RequirePermissions } from '../auth/guards/permissions.guard';

class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripDescription(data: any) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { description, ...rest } = data;
  return rest;
}

// No caller in this codebase previously caught Prisma's P2002 (unique
// constraint) for any of the 18 SIMPLE_MASTERS models — every one of
// them 500'd on a duplicate name with a raw "Internal server error"
// instead of the same clean "X already exists" 400 that RolesService/
// UsersService/CustomFieldsService give for their own duplicates (those
// pre-check via findFirst instead; a shared, dynamically-keyed factory
// has no fixed field name to pre-check against, so catching P2002 here
// is the equivalent fix for this one shared code path).
function mapDuplicateNameError(err: unknown, apiTag: string): unknown {
  if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
    return new BadRequestException(`${apiTag} with this name already exists`);
  }
  return err;
}

export interface MasterModuleConfig {
  modelName: string;
  routePath: string;
  apiTag: string;
  // createMasterSchema's `description` field is optional but only
  // PaymentPlanTemplate's Prisma model actually has a `description`
  // column — every other SIMPLE_MASTERS model threw
  // PrismaClientValidationError ("Unknown argument `description`")
  // whenever a caller provided one, since create()/update() below spread
  // the whole validated dto straight into Prisma's `data`. Default false
  // strips it; only the one model that supports it opts in.
  supportsDescription?: boolean;
  // Some SIMPLE_MASTERS models have their own genuinely required columns
  // beyond name/description/isActive/sortOrder (DocumentType.entityType,
  // InterestRule.rateType/ratePercent/frequency,
  // TransferFeeRule.feeType) — createMasterSchema doesn't have them at
  // all, so every create() attempt 500'd with Prisma's "Argument `x` is
  // missing" for these models specifically. Merged onto
  // createMasterSchema/updateMasterSchema (the update version made
  // partial, matching every other optional update field) rather than
  // giving these three yet another standalone module — unlike
  // LetterTemplate, none of them need custom validation logic beyond
  // "this field is required," so the generic factory's CRUD is still the
  // right fit once it actually knows about the field.
  extraFields?: z.ZodRawShape;
  /**
   * Runs inside update()'s transaction, before the write; throw to refuse it.
   * Used by InterestRule to keep the rate of a rule in use (interest-rule.master.ts).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  beforeUpdate?: (tx: any, companyId: string, id: string, data: Record<string, unknown>) => Promise<void>;
}

export function createMasterService(config: MasterModuleConfig) {
  @Injectable()
  class MasterService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tenantPrisma: any;
    systemPrisma: PrismaClient;

    constructor(
      @Inject(TENANT_PRISMA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tenantPrisma: any,
      @Inject(SYSTEM_PRISMA)
      systemPrisma: PrismaClient,
    ) {
      this.tenantPrisma = tenantPrisma;
      this.systemPrisma = systemPrisma;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get model(): any {
      const key = config.modelName.charAt(0).toLowerCase() + config.modelName.slice(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.systemPrisma as any)[key];
    }

    async findAll(companyId: string, query: PaginationQuery) {
      const { page, limit, search, sortBy, sortOrder } = query;
      const skip = (page - 1) * limit;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { companyId };
      if (search) {
        where.name = { contains: search, mode: 'insensitive' };
      }

      const [data, total] = await Promise.all([
        this.model.findMany({
          where,
          skip,
          take: limit,
          orderBy: sortBy
            ? { [sortBy]: sortOrder }
            : { sortOrder: 'asc' },
        }),
        this.model.count({ where }),
      ]);

      return {
        data,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }

    async findOne(companyId: string, id: string) {
      const item = await this.model.findFirst({
        where: { id, companyId },
      });
      if (!item) throw new NotFoundException(`${config.apiTag} not found`);
      return item;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async create(companyId: string, data: any) {
      const key = config.modelName.charAt(0).toLowerCase() + config.modelName.slice(1);
      const payload = config.supportsDescription ? data : stripDescription(data);
      try {
        return await runWithTenant({ companyId }, () =>
          withTenantTx(this.tenantPrisma, companyId, (tx) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tx as any)[key].create({
              data: { ...payload, companyId },
            }),
          ),
        );
      } catch (err) {
        throw mapDuplicateNameError(err, config.apiTag);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async update(companyId: string, id: string, data: any) {
      await this.findOne(companyId, id);
      const key = config.modelName.charAt(0).toLowerCase() + config.modelName.slice(1);
      const payload = config.supportsDescription ? data : stripDescription(data);
      try {
        return await runWithTenant({ companyId }, () =>
          withTenantTx(this.tenantPrisma, companyId, async (tx) => {
            await config.beforeUpdate?.(tx, companyId, id, payload);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (tx as any)[key].update({ where: { id }, data: payload });
          }),
        );
      } catch (err) {
        throw mapDuplicateNameError(err, config.apiTag);
      }
    }

    async remove(companyId: string, id: string) {
      await this.findOne(companyId, id);
      const key = config.modelName.charAt(0).toLowerCase() + config.modelName.slice(1);
      return runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, (tx) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tx as any)[key].delete({ where: { id } }),
        ),
      );
    }
  }

  Object.defineProperty(MasterService, 'name', {
    value: `${config.modelName}Service`,
  });

  return MasterService;
}

export function createMasterController(
  config: MasterModuleConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServiceClass: Type<any>,
) {
  // Per-config DTOs (not the shared top-level CreateMasterDto/
  // UpdateMasterDto) so a model with extraFields gets those fields
  // actually validated instead of silently accepted-then-500ing in
  // Prisma. Models with no extraFields keep using the plain schemas.
  const createSchema = config.extraFields ? createMasterSchema.extend(config.extraFields) : createMasterSchema;
  const updateSchema = config.extraFields
    ? updateMasterSchema.extend(z.object(config.extraFields).partial().shape)
    : updateMasterSchema;
  class ConfiguredCreateDto extends createZodDto(createSchema) {}
  class ConfiguredUpdateDto extends createZodDto(updateSchema) {}

  @ApiTags(config.apiTag)
  @Controller(`masters/${config.routePath}`)
  class MasterController {
    service: InstanceType<typeof ServiceClass>;
    constructor(@Inject(ServiceClass) service: InstanceType<typeof ServiceClass>) {
      this.service = service;
    }

    @Get()
    @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
    @ApiOperation({ summary: `List ${config.apiTag}` })
    findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
      const user = req.user as JwtPayload;
      return this.service.findAll(user.companyId, query);
    }

    @Get(':id')
    @RequirePermissions(PERMISSIONS.ADMIN_MASTER_READ)
    @ApiOperation({ summary: `Get ${config.apiTag} by ID` })
    findOne(@Param('id') id: string, @Req() req: Request) {
      const user = req.user as JwtPayload;
      return this.service.findOne(user.companyId, id);
    }

    @Post()
    @RequirePermissions(PERMISSIONS.ADMIN_MASTER_CREATE)
    @ApiOperation({ summary: `Create ${config.apiTag}` })
    create(@Body() dto: ConfiguredCreateDto, @Req() req: Request) {
      const user = req.user as JwtPayload;
      return this.service.create(user.companyId, dto);
    }

    @Patch(':id')
    @RequirePermissions(PERMISSIONS.ADMIN_MASTER_UPDATE)
    @ApiOperation({ summary: `Update ${config.apiTag}` })
    update(
      @Param('id') id: string,
      @Body() dto: ConfiguredUpdateDto,
      @Req() req: Request,
    ) {
      const user = req.user as JwtPayload;
      return this.service.update(user.companyId, id, dto);
    }

    @Delete(':id')
    @RequirePermissions(PERMISSIONS.ADMIN_MASTER_DELETE)
    @ApiOperation({ summary: `Delete ${config.apiTag}` })
    remove(@Param('id') id: string, @Req() req: Request) {
      const user = req.user as JwtPayload;
      return this.service.remove(user.companyId, id);
    }
  }

  Object.defineProperty(MasterController, 'name', {
    value: `${config.modelName}Controller`,
  });

  return MasterController;
}

export function createMasterModule(config: MasterModuleConfig) {
  const ServiceClass = createMasterService(config);
  const ControllerClass = createMasterController(config, ServiceClass);

  @Module({
    controllers: [ControllerClass],
    providers: [ServiceClass],
    exports: [ServiceClass],
  })
  class MasterModule {}

  Object.defineProperty(MasterModule, 'name', {
    value: `${config.modelName}Module`,
  });

  return MasterModule;
}
