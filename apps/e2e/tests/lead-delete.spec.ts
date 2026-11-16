import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

/**
 * Deleting a lead (v0.10.1): only for presales.lead.delete holders (seeded to
 * company_admin), behind a confirmation that needs a reason; the lead then
 * appears under Deleted leads and can be restored.
 */

const fixture = readFixture('leadDelete');
const ids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: API_URL });
  const res = await api.post('/api/v1/auth/login', { data: { email: fixture.adminEmail, password: fixture.adminPassword } });
  expect(res.ok()).toBe(true);
  const csrf = (await api.storageState()).cookies.find((c) => c.name === 'openestate_csrf')!.value;
  const headers = { Authorization: `Bearer ${(await res.json()).accessToken}`, 'X-CSRF-Token': csrf };
  const lead = await api.post('/api/v1/inquiries', { headers, data: { applicant: { name: 'Delete Me Lead', primaryPhone: '9811155501' } } });
  expect(lead.ok(), await lead.text()).toBe(true);
  ids.lead = (await lead.json()).id;
  await api.dispose();
});

async function signInAs(page: Page, role: string) {
  await login(page, { ...fixture, adminEmail: fixture.roleUsers![role] });
}

test('sales_manager: no Delete lead and no Deleted leads (not seeded with the permission)', async ({ page }) => {
  await signInAs(page, 'sales_manager');
  await page.goto('/presales/inquiries');
  await expect(page.getByRole('heading', { name: 'Inquiries' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Deleted leads' })).toHaveCount(0);
});

test('company_admin: deletes a lead after confirming with a reason, then restores it from Deleted leads', async ({ page }) => {
  await signInAs(page, 'company_admin');
  await page.goto(`/presales/inquiries/${ids.lead}`);
  await expect(page.getByRole('heading', { name: 'Delete Me Lead' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete lead…' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this lead?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("contact record is not deleted");
  const confirm = dialog.getByRole('button', { name: 'Yes, delete lead' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Reason').selectOption('DUPLICATE');
  await confirm.click();

  await expect(page).toHaveURL(/\/presales\/inquiries$/);
  await expect(page.getByRole('status')).toContainText('Lead deleted');
  await page.getByRole('searchbox', { name: /Search inquiries/ }).fill('9811155501');
  await expect(page.getByText('Delete Me Lead')).toHaveCount(0);

  await page.getByRole('link', { name: 'Deleted leads' }).click();
  const row = page.getByRole('row', { name: /Delete Me Lead/ });
  await expect(row).toContainText('Duplicate');
  await expect(row).not.toContainText('9811155501');
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status')).toContainText('restored');

  await page.goto(`/presales/inquiries/${ids.lead}`);
  await expect(page.getByRole('heading', { name: 'Delete Me Lead' })).toBeVisible();
});

test('"Keep lead" closes the confirmation and deletes nothing', async ({ page }) => {
  await signInAs(page, 'company_admin');
  await page.goto(`/presales/inquiries/${ids.lead}`);
  await page.getByRole('button', { name: 'Delete lead…' }).click();
  await page.getByRole('button', { name: 'Keep lead' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Delete Me Lead' })).toBeVisible();
});
