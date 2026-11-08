import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { maskPhoneFields, paginationQuerySchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { z } from 'zod';

const auditQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().max(50).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

class AuditQueryDto extends createZodDto(auditQuerySchema) {}

@ApiTags('Audit')
@Controller('audit')
export class AuditController {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly prisma: PrismaClient,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_AUDIT_READ)
  @ApiOperation({ summary: 'List audit log entries' })
  async findAll(@Query() query: AuditQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const { page, limit, entityType, entityId, userId } = query;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { companyId: user.companyId };
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (userId) where.userId = userId;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      // A list view: phone numbers in before/after snapshots are masked in
      // the response only. The stored audit rows are never changed.
      data: maskPhoneFields(data),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
