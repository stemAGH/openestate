import { PrismaClient } from '@prisma/client';
import { tenantExtension } from './tenant.extension';
import { auditExtension } from './audit.extension';
import { softDeleteExtension } from './soft-delete.extension';

export { PrismaClient } from '@prisma/client';
export { tenantExtension } from './tenant.extension';
export { auditExtension } from './audit.extension';
export { softDeleteExtension } from './soft-delete.extension';
export { setTenantOnTx, withTenantTx } from './tenant.extension';
export type { WithTenantTxOptions } from './tenant.extension';
export {
  tenantContext,
  tenantTxContext,
  getCurrentCompanyId,
  getCurrentUserId,
  getCurrentIpAddress,
  getCurrentPortalApplicantId,
  getCurrentPortalBrokerId,
  runWithTenant,
  runScoped,
  enterTenantContext,
} from './tenant-context';
export type { TenantStore, TenantTxStore } from './tenant-context';

let tenantPrisma: ReturnType<typeof createTenantPrismaClient> | undefined;
let systemPrisma: PrismaClient | undefined;

export function createTenantPrismaClient(url?: string) {
  const base = new PrismaClient(
    url ? { datasources: { db: { url } } } : undefined,
  );
  return base.$extends(softDeleteExtension()).$extends(tenantExtension()).$extends(auditExtension());
}

export function createSystemPrismaClient(url?: string): PrismaClient {
  const base = new PrismaClient(
    url ? { datasources: { db: { url } } } : undefined,
  );
  // Query hooks only: the client's model API is unchanged, so it stays typed
  // as PrismaClient for every existing caller.
  return base.$extends(softDeleteExtension()) as unknown as PrismaClient;
}

export function getTenantPrisma() {
  if (!tenantPrisma) {
    tenantPrisma = createTenantPrismaClient();
  }
  return tenantPrisma;
}

export function getSystemPrisma() {
  if (!systemPrisma) {
    systemPrisma = createSystemPrismaClient(
      process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL,
    );
  }
  return systemPrisma;
}
