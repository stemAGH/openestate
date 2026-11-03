/**
 * v0.9: how postsales.interest.manage reaches existing roles on upgrade, and
 * that it never widens a role beyond the role-baseline policy (v0.8.4 Part I).
 *
 *  - An install that has been on v0.8.4 or later (a seed baseline recorded
 *    before the key existed) gets it on accounts and company_admin.
 *  - An install upgrading straight from v0.8.3 (no baseline) gets it on no
 *    role: the baseline is recorded and the key is reported as missing.
 *  - Customised roles: a key an admin removed stays removed, a key an admin
 *    granted by hand (the documented manual procedure) is kept, and other
 *    roles never receive it.
 *
 * The seed defaults and the plain v0.8.4 path are interest-manage-delivery.test.ts;
 * this file adds the audit rows, the v0.8.3 path, the manual grant and
 * customised roles. Scoped to companies created here. Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { createSystemPrismaClient } from '../src/index';
import { syncPermissions, syncSystemRoleBaselines } from '../prisma/sync-permissions';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;
const KEY = PERMISSIONS.POSTSALES_INTEREST_MANAGE;

describeIf('v0.9: postsales.interest.manage on upgraded installs', () => {
  let prisma: PrismaClient;
  let keyToId: Map<string, string>;
  const companies: string[] = [];

  const seed = (slug: keyof typeof ROLE_PERMISSIONS) => [...new Set(ROLE_PERMISSIONS[slug])].sort();
  const preV09 = (slug: keyof typeof ROLE_PERMISSIONS) => seed(slug).filter((k) => k !== KEY);
  const held = async (roleId: string) =>
    (await prisma.rolePermission.findMany({ where: { roleId }, select: { permission: { select: { key: true } } } }))
      .map((r) => r.permission.key)
      .sort();
  const holds = async (roleId: string) => (await held(roleId)).includes(KEY);

  /** One company with pre-v0.9 system roles; `baseline` says whether v0.8.4+ recorded one. */
  async function company(baseline: boolean, customise?: (slug: string, keys: string[]) => string[]) {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const companyId = (await prisma.company.create({ data: { name: `Interest perm ${tag}`, slug: `int-perm-${tag}` } })).id;
    companies.push(companyId);
    const ids: Record<string, string> = {};
    for (const slug of [SYSTEM_ROLES.COMPANY_ADMIN, SYSTEM_ROLES.ACCOUNTS, SYSTEM_ROLES.SALES_MANAGER, SYSTEM_ROLES.SALES_EXECUTIVE]) {
      const keys = customise ? customise(slug, preV09(slug as keyof typeof ROLE_PERMISSIONS)) : preV09(slug as keyof typeof ROLE_PERMISSIONS);
      const role = await prisma.role.create({
        data: { companyId, name: slug, slug, isSystem: true, permissions: { create: keys.map((k) => ({ permissionId: keyToId.get(k)! })) } },
      });
      ids[slug] = role.id;
      if (baseline) {
        await prisma.roleSeedBaseline.create({ data: { roleId: role.id, permissionKeys: preV09(slug as keyof typeof ROLE_PERMISSIONS) } });
      }
    }
    ids.custom = (
      await prisma.role.create({
        data: { companyId, name: 'custom', slug: 'custom_interest', isSystem: false, permissions: { create: [{ permissionId: keyToId.get(seed('accounts')[0])! }] } },
      })
    ).id;
    return { companyId, ids };
  }

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    await syncPermissions(prisma);
    keyToId = new Map((await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.rolePermission.deleteMany({ where: { role: { companyId: { in: companies } } } });
    const roleIds = (await prisma.role.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((r) => r.id);
    await prisma.roleSeedBaseline.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { companyId: { in: companies } } });
    await prisma.auditLog.deleteMany({ where: { companyId: { in: companies } } });
    await deleteCompaniesSafely(prisma, companies);
    await prisma.$disconnect();
  });

  it('from v0.8.4 or later (baseline recorded): accounts and company_admin gain it, audited; nobody else does', async () => {
    const { companyId, ids } = await company(true);
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.rolesChanged).toBe(2);
    expect(await holds(ids.accounts)).toBe(true);
    expect(await holds(ids.company_admin)).toBe(true);
    expect(await holds(ids.sales_manager)).toBe(false);
    expect(await holds(ids.sales_executive)).toBe(false);
    expect(await holds(ids.custom)).toBe(false);
    const audit = await prisma.auditLog.findMany({ where: { companyId, action: 'ROLE_PERMS_CHANGED' }, orderBy: { entityId: 'asc' } });
    expect(audit.map((a) => a.entityId).sort()).toEqual([ids.accounts, ids.company_admin].sort());
    for (const a of audit) expect(a.after).toEqual({ added: [KEY], surface: 'upgrade' });
  });

  it('from v0.8.3 (no baseline): no role gains it; the baseline is recorded and the gap is reported', async () => {
    const { companyId, ids } = await company(false);
    const before = { accounts: await held(ids.accounts), company_admin: await held(ids.company_admin) };
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(0);
    expect(await held(ids.accounts)).toEqual(before.accounts);
    expect(await held(ids.company_admin)).toEqual(before.company_admin);
    expect(await prisma.auditLog.count({ where: { companyId, action: 'ROLE_PERMS_CHANGED' } })).toBe(0);
    for (const slug of ['accounts', 'company_admin']) {
      const line = r.differences.find((d) => d.startsWith(slug));
      expect(line, `${slug} difference line`).toContain(KEY);
      expect(line).toContain('lacks');
    }
  });

  it('the manual grant (Admin → Roles) after a v0.8.3 upgrade survives later syncs', async () => {
    const { companyId, ids } = await company(false);
    await syncSystemRoleBaselines(prisma, { companyId });
    await prisma.rolePermission.create({ data: { roleId: ids.accounts, permissionId: keyToId.get(KEY)! } });
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r).toMatchObject({ added: 0, rolesChanged: 0 });
    expect(await holds(ids.accounts)).toBe(true);
    expect(await holds(ids.company_admin)).toBe(false);
  });

  it('customised roles: a removal after the grant is never undone; other customisations are kept', async () => {
    const OTHER = preV09('company_admin')[0];
    const EXTRA = 'portal.booking.read';
    const { companyId, ids } = await company(true, (slug, keys) =>
      slug === SYSTEM_ROLES.COMPANY_ADMIN ? [...keys.filter((k) => k !== OTHER), EXTRA] : keys,
    );
    await syncSystemRoleBaselines(prisma, { companyId });
    const admin = await held(ids.company_admin);
    expect(admin).toContain(KEY);
    expect(admin).not.toContain(OTHER);
    expect(admin).toContain(EXTRA);

    await prisma.rolePermission.deleteMany({ where: { roleId: ids.accounts, permission: { key: KEY } } });
    const r = await syncSystemRoleBaselines(prisma, { companyId });
    expect(r.added).toBe(0);
    expect(await holds(ids.accounts)).toBe(false);
  });
});
