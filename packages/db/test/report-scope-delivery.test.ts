/**
 * v0.10.1 (QA-009): reports.postsales.company-wide reaches accounts and
 * company_admin on an existing install through the per-role seed baseline,
 * and no sales role. An admin who removes it from accounts keeps it removed:
 * a later sync does not add it back.
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
const NEW_KEY = 'reports.postsales.company-wide';

describeIf('v0.10.1: reports.postsales.company-wide delivered by the seed baseline', () => {
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
    companyId = (await prisma.company.create({ data: { name: `Report Scope Co ${tag}`, slug: `report-scope-${tag}` } })).id;
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

  it('the key exists, and the seeds give it to accounts, company_admin and super_admin only', () => {
    expect(Object.values(PERMISSIONS)).toContain(NEW_KEY);
    const holders = Object.entries(ROLE_PERMISSIONS).filter(([, keys]) => (keys as string[]).includes(NEW_KEY)).map(([slug]) => slug).sort();
    expect(holders).toEqual(['accounts', 'company_admin', 'super_admin']);
  });

  it('one sync adds exactly the new key to accounts and company_admin', async () => {
    const before = {
      admin: await held(roleIds.company_admin),
      accounts: await held(roleIds.accounts),
      manager: await held(roleIds.sales_manager),
      exec: await held(roleIds.sales_executive),
    };
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(2);
    expect(r.rolesChanged).toBe(2);
    expect(await held(roleIds.company_admin)).toEqual([...before.admin, NEW_KEY].sort());
    expect(await held(roleIds.accounts)).toEqual([...before.accounts, NEW_KEY].sort());
    expect(await held(roleIds.sales_manager)).toEqual(before.manager);
    expect(await held(roleIds.sales_executive)).toEqual(before.exec);

    const audit = await prisma.auditLog.findMany({ where: { companyId, action: 'ROLE_PERMS_CHANGED' } });
    expect(audit.map((a) => (a.after as { added: string[] }).added)).toEqual([[NEW_KEY], [NEW_KEY]]);
  });

  it('a key an admin removed from accounts is not added back by the next sync', async () => {
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: NEW_KEY } });
    await prisma.rolePermission.deleteMany({ where: { roleId: roleIds.accounts, permissionId: perm.id } });
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(0);
    expect(await held(roleIds.accounts)).not.toContain(NEW_KEY);
  });
});
