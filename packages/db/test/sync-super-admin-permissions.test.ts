/**
 * Regression test for a real upgrade-path bug found on a
 * verification VM while taking it from v0.1.2 to v0.2.3.
 *
 * `permissions` had all 142 rows (syncPermissions did its job), but
 * `super_admin` on companies that predated v0.2.0 still held only 140 —
 * missing exactly the two that release added
 * (`inventory.unit.plc-manage` / `inventory.unit.charge-manage`). The
 * PLC pricing UI those gate was therefore unreachable on every upgraded
 * install, for the most privileged role in the product, with no error
 * explaining why.
 *
 * `syncSuperAdminPermissions` closes it for super_admin ONLY — see that
 * function's own doc comment and CLAUDE.md for why the narrowing stops
 * there. These tests pin both halves: the grant happens for super_admin,
 * and it provably does NOT happen for company_admin or a custom role.
 *
 * Needs DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { createSystemPrismaClient } from '../src/index';
import { syncPermissions, syncSuperAdminPermissions } from '../prisma/sync-permissions';
import { deleteCompaniesSafely } from './helpers/delete-company-safely';

const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = SYSTEM_URL ? describe : describe.skip;

describeIf('syncSuperAdminPermissions: upgrade-path grant repair', () => {
  let prisma: PrismaClient;
  let companyId: string;
  let superAdminRoleId: string;
  let companyAdminRoleId: string;
  let customRoleId: string;

  // The two v0.2.0 keys whose absence was the actual production bug.
  const V020_KEYS = ['inventory.unit.plc-manage', 'inventory.unit.charge-manage'];

  beforeAll(async () => {
    prisma = createSystemPrismaClient(SYSTEM_URL!) as unknown as PrismaClient;
    await syncPermissions(prisma);

    const tag = Date.now();
    const company = await prisma.company.create({
      data: { name: `SyncPerm Co ${tag}`, slug: `syncperm-${tag}` },
    });
    companyId = company.id;

    const allPerms = await prisma.permission.findMany({ select: { id: true, key: true } });
    const idsExcept = (excludeKeys: string[]) =>
      allPerms.filter((p) => !excludeKeys.includes(p.key)).map((p) => p.id);

    // Reproduce the exact pre-upgrade shape: super_admin holding
    // everything EXCEPT the keys a later release introduced.
    const superAdmin = await prisma.role.create({
      data: {
        companyId,
        name: 'Super Admin',
        slug: SYSTEM_ROLES.SUPER_ADMIN,
        isSystem: true,
        permissions: { create: idsExcept(V020_KEYS).map((permissionId) => ({ permissionId })) },
      },
    });
    superAdminRoleId = superAdmin.id;

    // A deliberately NARROWED company_admin — this is the case the
    // original "never touch role_permissions" decision protects, and it
    // must stay narrowed after the sync runs.
    const companyAdmin = await prisma.role.create({
      data: {
        companyId,
        name: 'Company Admin',
        slug: SYSTEM_ROLES.COMPANY_ADMIN,
        isSystem: true,
        permissions: { create: allPerms.slice(0, 5).map((p) => ({ permissionId: p.id })) },
      },
    });
    companyAdminRoleId = companyAdmin.id;

    const custom = await prisma.role.create({
      data: {
        companyId,
        name: 'Site Visit Coordinator',
        slug: `site-visit-coordinator-${tag}`,
        isSystem: false,
        permissions: { create: allPerms.slice(0, 3).map((p) => ({ permissionId: p.id })) },
      },
    });
    customRoleId = custom.id;
  });

  afterAll(async () => {
    await prisma.rolePermission.deleteMany({
      where: { roleId: { in: [superAdminRoleId, companyAdminRoleId, customRoleId] } },
    });
    await prisma.role.deleteMany({ where: { companyId } });
    // Retries on syncLeadStages' own race — see delete-company-safely.ts's
    // doc comment for the exact mechanism (a single delete-then-delete
    // sequence is not enough).
    await deleteCompaniesSafely(prisma, [companyId]);
    await prisma.$disconnect();
  });

  async function grantedKeys(roleId: string): Promise<string[]> {
    const rows = await prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { key: true } } },
    });
    return rows.map((r) => r.permission.key).sort();
  }

  it('reproduces the bug first: super_admin is missing the keys a later release added', async () => {
    const before = await grantedKeys(superAdminRoleId);
    for (const key of V020_KEYS) {
      expect(before).not.toContain(key);
    }
    expect(before.length).toBe(ALL_PERMISSIONS.length - V020_KEYS.length);
  });

  it('grants super_admin every permission, so an upgraded install can actually reach new features', async () => {
    // NOT asserting skipped === 0: syncSuperAdminPermissions scans every
    // super_admin role in the shared test database, so a DIFFERENT test
    // file's fixture company/role can legitimately vanish mid-sync under
    // a full-suite run and get counted here too — see
    // sync-lead-stages.test.ts's identical note and the dedicated skip
    // test below.
    const { granted } = await syncSuperAdminPermissions(prisma);
    expect(granted).toBeGreaterThanOrEqual(V020_KEYS.length);

    const after = await grantedKeys(superAdminRoleId);
    for (const key of V020_KEYS) {
      expect(after).toContain(key);
    }
    // The real assertion: super_admin's contract is ALL of them.
    expect(after.length).toBe(ALL_PERMISSIONS.length);
    expect(after).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('is idempotent — a second run grants nothing and changes nothing', async () => {
    const before = await grantedKeys(superAdminRoleId);
    // Not asserting skipped === 0 here either — same shared-database
    // reasoning as the test above.
    const { granted } = await syncSuperAdminPermissions(prisma);
    expect(granted).toBe(0);
    expect(await grantedKeys(superAdminRoleId)).toEqual(before);
  });

  it('does NOT widen a deliberately narrowed company_admin', async () => {
    const keys = await grantedKeys(companyAdminRoleId);
    expect(keys.length).toBe(5);
    expect(keys.length).toBeLessThan(ALL_PERMISSIONS.length);
  });

  it('does NOT widen a custom role', async () => {
    const keys = await grantedKeys(customRoleId);
    expect(keys.length).toBe(3);
  });

  it('returns 0 when the install has no super_admin role at all', async () => {
    await prisma.rolePermission.deleteMany({ where: { roleId: superAdminRoleId } });
    await prisma.role.delete({ where: { id: superAdminRoleId } });
    expect(await syncSuperAdminPermissions(prisma)).toEqual({ granted: 0, skipped: 0 });

    // Recreate so afterAll's cleanup stays uniform.
    const recreated = await prisma.role.create({
      data: { companyId, name: 'Super Admin', slug: SYSTEM_ROLES.SUPER_ADMIN, isSystem: true },
    });
    superAdminRoleId = recreated.id;
  });

  it('a role that vanishes between listing and writing is skipped, counted, and logged — not thrown', async () => {
    // Deterministic reproduction of the race isForeignKeyViolation's doc
    // comment describes, not a timing-dependent guess: a Proxy deletes
    // the ROLE (not the company — deleting the company here would fail
    // its own FK check while the role still references it, which is a
    // different failure than the one being tested) right before
    // createMany runs, guaranteeing role_permissions_role_id_fkey fires.
    const tag = Date.now();
    const vanishingCompany = await prisma.company.create({
      data: { name: `SyncPerm Vanishes ${tag}`, slug: `syncperm-vanishes-${tag}` },
    });
    const vanishingRole = await prisma.role.create({
      data: { companyId: vanishingCompany.id, name: 'Super Admin', slug: SYSTEM_ROLES.SUPER_ADMIN, isSystem: true },
    });

    let intercepted = false;
    const poisoned = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'rolePermission' && !intercepted) {
          const real = Reflect.get(target, prop, receiver);
          return new Proxy(real, {
            get(realTarget, realProp, realReceiver) {
              if (realProp === 'createMany') {
                return async (args: unknown) => {
                  intercepted = true;
                  await target.role.delete({ where: { id: vanishingRole.id } });
                  return realTarget.createMany(args);
                };
              }
              return Reflect.get(realTarget, realProp, realReceiver);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { skipped } = await syncSuperAdminPermissions(poisoned as PrismaClient);
      expect(skipped).toBeGreaterThanOrEqual(1);
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(vanishingRole.id))).toBe(true);
    } finally {
      errorSpy.mockRestore();
      // The role was already deleted by the proxy above; only the
      // company is left to clean up. Uses the same race-retrying helper
      // as this file's afterAll — this fresh company has no
      // leadStagesSeededAt marker either, so it's exposed to the exact
      // same syncLeadStages race.
      await deleteCompaniesSafely(prisma, [vanishingCompany.id]);
    }
  });
});
