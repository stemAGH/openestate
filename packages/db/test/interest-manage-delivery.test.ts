/**
 * v0.9 ruling (f): postsales.interest.manage reaches accounts and company_admin
 * on an existing install through the v0.8.4 per-role seed baseline. The roles
 * here are in the state a v0.8.4 install leaves them: holding, and baselined
 * at, their seed without the new key. One sync must add exactly that key to
 * those two roles, and nothing to sales_manager (whose seed doesn't have it).
 *
 * (An install that skipped v0.8.4 has no baseline yet: its first sync records
 * one and adds nothing, and lists the missing key for an admin. That is the
 * Part I design, covered by sync-system-role-baselines.test.ts.)
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
const NEW_KEY = PERMISSIONS.POSTSALES_INTEREST_MANAGE;

describeIf('v0.9: postsales.interest.manage delivered by the seed baseline', () => {
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
    companyId = (await prisma.company.create({ data: { name: `Interest Manage Co ${tag}`, slug: `interest-manage-${tag}` } })).id;
    for (const slug of [SYSTEM_ROLES.COMPANY_ADMIN, SYSTEM_ROLES.ACCOUNTS, SYSTEM_ROLES.SALES_MANAGER]) {
      const v084Seed = [...new Set(ROLE_PERMISSIONS[slug])].filter((k) => k !== NEW_KEY).sort();
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

  it('the seeds give the key to accounts and company_admin, not sales_manager', () => {
    expect(ROLE_PERMISSIONS.accounts).toContain(NEW_KEY);
    expect(ROLE_PERMISSIONS.company_admin).toContain(NEW_KEY);
    expect(ROLE_PERMISSIONS.sales_manager).not.toContain(NEW_KEY);
  });

  it('one sync adds exactly the new key to accounts and company_admin', async () => {
    const before = {
      admin: await held(roleIds.company_admin),
      accounts: await held(roleIds.accounts),
      manager: await held(roleIds.sales_manager),
    };
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(2);
    expect(r.rolesChanged).toBe(2);
    expect(await held(roleIds.company_admin)).toEqual([...before.admin, NEW_KEY].sort());
    expect(await held(roleIds.accounts)).toEqual([...before.accounts, NEW_KEY].sort());
    expect(await held(roleIds.sales_manager)).toEqual(before.manager);

    const audit = await prisma.auditLog.findMany({ where: { companyId, action: 'ROLE_PERMS_CHANGED' } });
    expect(audit.map((a) => (a.after as { added: string[] }).added)).toEqual([[NEW_KEY], [NEW_KEY]]);
  });
});
