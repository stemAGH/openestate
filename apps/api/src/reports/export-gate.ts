import { ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';
import { maskPhone, PERMISSIONS, type JwtPayload } from '@openestate/shared';

/**
 * CSV downloads take personal data (full phone numbers among it) out of the
 * system, so every report CSV needs presales.report.export. The post-sales
 * and broker CSVs borrow this pre-sales permission for now (docs/todo.md:
 * a dedicated reports.export permission).
 */
export function requireExport(user: JwtPayload): void {
  if (!user.permissions.includes(PERMISSIONS.PRESALES_REPORT_EXPORT)) {
    throw new ForbiddenException('Missing presales.report.export permission');
  }
}

/** One immutable audit row per CSV download, like the pre-sales exports. */
export async function auditExport(
  prisma: PrismaClient,
  args: { user: JwtPayload; entityType: 'PostsalesReport' | 'BrokerReport'; reportKey: string; filters: object; rowCount: number; ip?: string },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      companyId: args.user.companyId,
      userId: args.user.sub,
      entityType: args.entityType,
      entityId: args.reportKey,
      action: 'EXPORT',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's JSON input type; filters are zod-validated query values
      after: { filters: args.filters, rowCount: args.rowCount } as any,
      ipAddress: args.ip,
    },
  });
}

/** The on-screen (JSON) variant of a report is a list view: mask the phone column. */
export function maskColumn(rows: unknown[][], index: number): unknown[][] {
  return rows.map((r) => r.map((v, i) => (i === index && typeof v === 'string' ? maskPhone(v) : v)));
}
