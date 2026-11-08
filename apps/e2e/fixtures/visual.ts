import * as argon2 from '@node-rs/argon2';
import { createSystemPrismaClient } from '@openestate/db';
import { ROLE_DISPLAY_NAMES, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { seedE2eFixture, type E2eFixture } from './seed';

/** Staff roles the visual/axe spec signs in as, besides the fixture's super_admin. */
export const VISUAL_ROLES = [
  SYSTEM_ROLES.COMPANY_ADMIN,
  SYSTEM_ROLES.SALES_MANAGER,
  SYSTEM_ROLES.SALES_EXECUTIVE,
  SYSTEM_ROLES.ACCOUNTS,
] as const;

const NAMES: Record<string, string> = {
  company_admin: 'Rohit Admin',
  sales_manager: 'Meera Manager',
  sales_executive: 'Vikram Executive',
  accounts: 'Kavita Accounts',
};

/**
 * Its own company for visual-baseline.spec.ts: one user per staff role with
 * the role's seeded permissions, the executive reporting to the manager.
 * Names are fixed (not tagged) so screenshots stay comparable between runs;
 * only e-mail addresses carry the run tag, and the spec masks them.
 */
export async function seedVisualFixture(databaseUrlSystem: string): Promise<E2eFixture> {
  const fixture = await seedE2eFixture(databaseUrlSystem);
  const prisma = createSystemPrismaClient(databaseUrlSystem);
  try {
    const perms = new Map((await prisma.permission.findMany()).map((p: { key: string; id: string }) => [p.key, p.id]));
    const hash = await argon2.hash(fixture.adminPassword, { algorithm: argon2.Algorithm.Argon2id });
    const tag = fixture.adminEmail.replace(/^admin-|@.*$/g, '');
    const roleUsers: Record<string, string> = {};
    let managerId: string | null = null;
    for (const slug of VISUAL_ROLES) {
      const role = await prisma.role.create({
        data: { companyId: fixture.companyId, name: ROLE_DISPLAY_NAMES[slug], slug, isSystem: true },
      });
      await prisma.rolePermission.createMany({
        data: ROLE_PERMISSIONS[slug]
          .map((k) => perms.get(k))
          .filter((id): id is string => !!id)
          .map((permissionId) => ({ roleId: role.id, permissionId })),
      });
      const email = `${slug.replace('_', '-')}-${tag}@e2e-harness.test`;
      const user: { id: string } = await prisma.user.create({
        data: {
          companyId: fixture.companyId,
          email,
          name: NAMES[slug],
          roleId: role.id,
          passwordHash: hash,
          forcePasswordChange: false,
          managerId: slug === SYSTEM_ROLES.SALES_EXECUTIVE ? managerId : null,
        },
      });
      if (slug === SYSTEM_ROLES.SALES_MANAGER) managerId = user.id;
      roleUsers[slug] = email;
    }
    await prisma.user.update({
      where: { companyId_email: { companyId: fixture.companyId, email: fixture.adminEmail } },
      data: { name: 'Asha Admin' },
    });
    return { ...fixture, roleUsers };
  } finally {
    await prisma.$disconnect();
  }
}
