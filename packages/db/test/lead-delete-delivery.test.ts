/**
 * v0.10.1: presales.lead.delete (deleting a lead) reaches company_admin on an
 * existing install through the per-role seed baseline, and no other role:
 * sales_manager takes every other pre-sales key, but not this one, and keeps
 * the unused presales.inquiry.delete it already held. (super_admin holds every
 * key through its own sync.) An admin who removes it keeps it removed.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { createSystemPrismaClient } from '../src/index';
import { syncPermissions, syncSystemRoleBaselines } from '../prisma/sync-permissions';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;
// A string, not PERMISSIONS.X, so this file compiles before the key exists.
const NEW_KEY = 'presales.lead.delete';

describeIf('v0.10.1: presales.lead.delete delivered by the seed baseline', () => {
  let prisma: PrismaClient;
  let companyId: string;
  const roleIds: Record<string, string> = {};

  const held = async (roleId: string) =>
    (await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { key: true } } } }))
      .map((r) => r.permission.key)
      .sort();

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    await syncPermissions(prisma);
    const keyToId = new Map((await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));
    const tag = Date.now();
    companyId = (await prisma.company.create({ data: { name: `Lead Delete Co ${tag}`, slug: `lead-delete-${tag}` } })).id;
    for (const slug of [SYSTEM_ROLES.COMPANY_ADMIN, SYSTEM_ROLES.ACCOUNTS, SYSTEM_ROLES.SALES_MANAGER, SYSTEM_ROLES.SALES_EXECUTIVE]) {
      const v084Seed = ([...new Set(ROLE_PERMISSIONS[slug])] as string[]).filter((k) => k !== NEW_KEY).sort();
      const role = await prisma.role.create({
        data: {
          companyId,
          name: slug,
          slug,
          isSystem: true,
          permissions: { create: v084Seed.map((k) => ({ permissionId: keyToId.get(k)! })) },
        },
      });
      await prisma.roleSeedBaseline.create({ data: { roleId: role.id, permissionKeys: v084Seed } });
      roleIds[slug] = role.id;
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.rolePermission.deleteMany({ where: { role: { companyId } } });
    await prisma.role.deleteMany({ where: { companyId } });
    await prisma.auditLog.deleteMany({ where: { companyId } });
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  it('the key exists, and the seeds give it to company_admin and super_admin only', () => {
    expect(Object.values(PERMISSIONS)).toContain(NEW_KEY);
    const holders = Object.entries(ROLE_PERMISSIONS).filter(([, keys]) => (keys as string[]).includes(NEW_KEY)).map(([slug]) => slug).sort();
    expect(holders).toEqual(['company_admin', 'super_admin']);
    expect(ROLE_PERMISSIONS.sales_manager).toContain(PERMISSIONS.PRESALES_INQUIRY_DELETE);
  });

  it('one sync adds exactly the new key to company_admin, and nothing to accounts or the sales roles', async () => {
    const before = {
      admin: await held(roleIds.company_admin),
      accounts: await held(roleIds.accounts),
      manager: await held(roleIds.sales_manager),
      exec: await held(roleIds.sales_executive),
    };
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(1);
    expect(r.rolesChanged).toBe(1);
    expect(await held(roleIds.company_admin)).toEqual([...before.admin, NEW_KEY].sort());
    expect(await held(roleIds.accounts)).toEqual(before.accounts);
    expect(await held(roleIds.sales_manager)).toEqual(before.manager);
    expect(await held(roleIds.sales_executive)).toEqual(before.exec);

    const audit = await prisma.auditLog.findMany({ where: { companyId, action: 'ROLE_PERMS_CHANGED' } });
    expect(audit.map((a) => (a.after as { added: string[] }).added)).toEqual([[NEW_KEY]]);
  });

  it('a key an admin removed from company_admin is not added back by the next sync', async () => {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: NEW_KEY } });
    await prisma.rolePermission.deleteMany({ where: { roleId: roleIds.company_admin, permissionId: perm.id } });
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(0);
    expect(await held(roleIds.company_admin)).not.toContain(NEW_KEY);
  });
});
