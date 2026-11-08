import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { ALL_PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * v0.4's manager hierarchy, driven entirely through the real UI: the new
 * Manager field on the Add/Edit User form, then a real login as each user
 * to prove visibility follows the org chart. Reuses the `mastersCrud`
 * fixture (company + admin + a project) — nothing here needs pricing,
 * cheques, or tickets, matching `user-role-edit.spec.ts`'s own precedent
 * of reusing an existing fixture rather than adding a new named one.
 *
 * This is the UI-level twin of `apps/api/test/e2e-team-scope.test.ts`'s
 * through-the-wire coverage — that file proves the API scopes correctly;
 * this file proves a real admin can actually SET the manager relationship
 * through the form, and that the resulting visibility is what a person
 * clicking through the app would see.
 */
test('manager sees a report\'s inquiry; a peer with no management relationship does not', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const tag = Date.now();
  const staffPassword = 'TeamScopePass123';

  try {
    // Setup only: a role with the presales permissions these users need —
    // not part of the behavior under test, matching this file's own
    // precedent (user-role-edit.spec.ts's second role) for seeding a role
    // directly rather than through the Roles UI.
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await prisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));
    const staffRole = await prisma.role.create({
      data: { companyId: fixture.companyId, name: `E2E Sales Rep ${tag}`, slug: `e2e-sales-rep-${tag}`, isSystem: false },
    });
    const permData = ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id)
      .map((permissionId) => ({ roleId: staffRole.id, permissionId }));
    await prisma.rolePermission.createMany({ data: permData });

    const managerEmail = `e2e-manager-${tag}@test.com`;
    const execEmail = `e2e-exec-${tag}@test.com`;
    const peerEmail = `e2e-peer-${tag}@test.com`;

    await login(page, fixture);

    // Create the manager first (no manager of their own).
    await page.goto('/admin/users/new');
    await controlAfterLabel(page, 'Name').fill('E2E Manager');
    await controlAfterLabel(page, 'Email').fill(managerEmail);
    await controlAfterLabel(page, 'Password').fill(staffPassword);
    await controlAfterLabel(page, 'Role').selectOption({ label: staffRole.name });
    const [managerCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create User' }).click(),
    ]);
    expect(managerCreateRes.ok()).toBe(true);
    await expect(page).toHaveURL(/\/admin\/users$/);

    // Create the peer — same role, no manager. Proves scoping follows the
    // org chart, not the role: peer and exec share a role but not a chain.
    await page.goto('/admin/users/new');
    await controlAfterLabel(page, 'Name').fill('E2E Peer');
    await controlAfterLabel(page, 'Email').fill(peerEmail);
    await controlAfterLabel(page, 'Password').fill(staffPassword);
    await controlAfterLabel(page, 'Role').selectOption({ label: staffRole.name });
    const [peerCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create User' }).click(),
    ]);
    expect(peerCreateRes.ok()).toBe(true);

    // Create the exec WITH the Manager field set to E2E Manager, in the
    // same create form — this is the field under test.
    await page.goto('/admin/users/new');
    await controlAfterLabel(page, 'Name').fill('E2E Exec');
    await controlAfterLabel(page, 'Email').fill(execEmail);
    await controlAfterLabel(page, 'Password').fill(staffPassword);
    await controlAfterLabel(page, 'Role').selectOption({ label: staffRole.name });
    await controlAfterLabel(page, 'Manager').selectOption({ label: 'E2E Manager' });
    const [execCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create User' }).click(),
    ]);
    expect(execCreateRes.ok()).toBe(true);

    // Every real staff user is created with forcePasswordChange: true
    // (UsersService.create) — this test is about hierarchy visibility,
    // not the forced-password-change flow (covered by auth-2fa.spec.ts),
    // so flip it off directly, matching seedE2eFixture's own
    // forcePasswordChange-off-by-default convention.
    await prisma.user.updateMany({
      where: { email: { in: [managerEmail, peerEmail, execEmail] } },
      data: { forcePasswordChange: false },
    });

    // Confirm the manager relationship actually persisted, through a
    // fresh page load of the exec's own edit form — not just a 200.
    await page.goto('/admin/users');
    const execRow = page.getByRole('row', { name: /E2E Exec/ });
    await execRow.getByRole('link', { name: 'Edit' }).click();
    await expect(controlAfterLabel(page, 'Manager')).toHaveValue(/.+/);

    // Log in as the exec and create an inquiry — creator-retains-lead
    // (v0.3.1) means this lands on the exec themselves.
    const leadName = `Team Scope Lead ${tag}`;
    // /login redirects an already-authenticated session straight back to
    // "/" — must sign out first, matching the real AppShell control a
    // person would click, not just navigate past it.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(execEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/inquiries');
    await page.getByRole('button', { name: 'New inquiry' }).click();
    await controlAfterLabel(page, 'Applicant Name').fill(leadName);
    await controlAfterLabel(page, 'Phone').fill('9800500001');
    // By value (projectId), not by label — project-edit.spec.ts runs
    // concurrently against this same shared mastersCrud fixture and
    // renames its project as part of what IT tests; the id is stable,
    // the display name isn't.
    await controlAfterLabel(page, 'Project').selectOption({ value: fixture.projectId });
    const [inquiryCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create' }).click(),
    ]);
    expect(inquiryCreateRes.ok()).toBe(true);
    await expect(page.getByRole('link', { name: leadName, exact: true })).toBeVisible();

    // Log in as the manager — the exec's lead must be visible (full
    // subtree, not blocked by scoping).
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(managerEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/inquiries');
    await expect(page.getByRole('link', { name: leadName, exact: true })).toBeVisible();

    // Log in as the peer — same role, no management relationship to the
    // exec — the lead must NOT be visible.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(peerEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/inquiries');
    await expect(page.getByRole('link', { name: leadName, exact: true })).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
