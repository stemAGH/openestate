import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { ALL_PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * v0.4 follow-up: a manager-tier user (holds PRESALES_INQUIRY_ASSIGN) whose
 * Inquiries list is empty because they have zero reports configured sees an
 * inline hint pointing at Admin -> Users, instead of the same "No data
 * found" a genuinely-empty list would show — the exact confusion the
 * manager-hierarchy behavioral change (v0.4) would otherwise cause for an
 * admin who hasn't set up the org chart yet.
 *
 * Reuses the `mastersCrud` fixture, matching `team-scope.spec.ts`'s own
 * precedent. Uses two DISTINCT roles (real sales_manager / sales_executive
 * permission sets), not one blended role like team-scope.spec.ts — this
 * test specifically depends on PRESALES_INQUIRY_ASSIGN being present for
 * the manager and doesn't need to be present for the exec.
 */
test('manager-tier user with zero reports sees the empty-team hint; it disappears once a report is configured', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const tag = Date.now();
  const staffPassword = 'EmptyTeamPass123';

  try {
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await prisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

    const managerRole = await prisma.role.create({
      data: { companyId: fixture.companyId, name: `E2E EmptyTeamTest ManagerRole ${tag}`, slug: `e2e-emptyteamtest-managerrole-${tag}`, isSystem: false },
    });
    await prisma.rolePermission.createMany({
      data: ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_MANAGER]
        .map((key) => permByKey.get(key))
        .filter((id): id is string => !!id)
        .map((permissionId) => ({ roleId: managerRole.id, permissionId })),
    });

    const execRole = await prisma.role.create({
      data: { companyId: fixture.companyId, name: `E2E EmptyTeamTest RepRole ${tag}`, slug: `e2e-emptyteamtest-reprole-${tag}`, isSystem: false },
    });
    await prisma.rolePermission.createMany({
      data: ROLE_PERMISSIONS[SYSTEM_ROLES.SALES_EXECUTIVE]
        .map((key) => permByKey.get(key))
        .filter((id): id is string => !!id)
        .map((permissionId) => ({ roleId: execRole.id, permissionId })),
    });

    const managerEmail = `e2e-empty-manager-${tag}@test.com`;
    const execEmail = `e2e-empty-exec-${tag}@test.com`;

    await login(page, fixture);

    await page.goto('/admin/users/new');
    await controlAfterLabel(page, 'Name').fill('E2E Empty Team Manager');
    await controlAfterLabel(page, 'Email').fill(managerEmail);
    await controlAfterLabel(page, 'Password').fill(staffPassword);
    await controlAfterLabel(page, 'Role').selectOption({ label: managerRole.name });
    const [managerCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create User' }).click(),
    ]);
    expect(managerCreateRes.ok()).toBe(true);

    await page.goto('/admin/users/new');
    await controlAfterLabel(page, 'Name').fill('E2E Empty Team Exec');
    await controlAfterLabel(page, 'Email').fill(execEmail);
    await controlAfterLabel(page, 'Password').fill(staffPassword);
    await controlAfterLabel(page, 'Role').selectOption({ label: execRole.name });
    const [execCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create User' }).click(),
    ]);
    expect(execCreateRes.ok()).toBe(true);

    await prisma.user.updateMany({
      where: { email: { in: [managerEmail, execEmail] } },
      data: { forcePasswordChange: false },
    });

    // Log in as the manager while they have zero reports — the hint must
    // render, naming Admin -> Users.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(managerEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/inquiries');
    await expect(page.getByText('Your team has no reports configured yet')).toBeVisible();
    const hintLink = page.getByRole('link', { name: /Admin.*Users/ });
    await expect(hintLink).toBeVisible();

    // Follow the hint's own link — it must actually land on Admin -> Users,
    // and the seeded sales_manager permission set (ADMIN_USER_READ, no
    // ADMIN_ROLE_READ/ADMIN_USER_UPDATE) is enough to reach it and see the
    // list, confirming the hint's link genuinely works for this role.
    await hintLink.click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole('row', { name: /E2E Empty Team Exec/ })).toBeVisible();

    // Actually EDITING the assignment needs ADMIN_USER_UPDATE (and the
    // Role dropdown needs ADMIN_ROLE_READ to populate at all) — neither is
    // in sales_manager's default permission set, a real RBAC boundary, not
    // an oversight. Matches how this was verified manually on the VM: an
    // admin performs the assignment; the manager's part of "self-serve" is
    // seeing the hint and knowing exactly where to point someone.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, fixture);

    await page.goto('/admin/users');
    const execRow = page.getByRole('row', { name: /E2E Empty Team Exec/ });
    await execRow.getByRole('link', { name: 'Edit' }).click();
    await page.waitForURL(/\/admin\/users\/.+/);
    // UserForm.tsx's reset() effect only fires once existingUser/roles/
    // usersPage have all loaded — interacting with the form before then
    // races it (the exact class of bug documented in this project's own
    // history: a native <select>'s value assignment silently no-ops if it
    // runs before reset() has populated the form). Wait for the real DOM
    // state — Name populated — before touching anything else.
    await expect(controlAfterLabel(page, 'Name')).toHaveValue('E2E Empty Team Exec');
    await controlAfterLabel(page, 'Manager').selectOption({ label: 'E2E Empty Team Manager' });
    const [updateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/users/') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Update User' }).click(),
    ]);
    expect(updateRes.ok()).toBe(true);

    // Log in as the exec and create a lead — creator-retains-lead means it
    // lands on the exec, now the manager's report.
    const leadName = `Empty Team Hint Lead ${tag}`;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(execEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/inquiries');
    await page.getByRole('button', { name: 'New inquiry' }).click();
    await controlAfterLabel(page, 'Applicant Name').fill(leadName);
    await controlAfterLabel(page, 'Phone').fill('9800800001');
    await controlAfterLabel(page, 'Project').selectOption({ value: fixture.projectId });
    const [inquiryCreateRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create' }).click(),
    ]);
    expect(inquiryCreateRes.ok()).toBe(true);

    // Log back in as the manager — the hint must be gone, and the report's
    // lead must be visible.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('#email').fill(managerEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/inquiries');
    await expect(page.getByText('Your team has no reports configured yet')).not.toBeVisible();
    await expect(page.getByRole('link', { name: leadName, exact: true })).toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
