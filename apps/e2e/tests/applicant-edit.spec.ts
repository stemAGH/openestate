import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

/**
 * Editing an applicant's contact (v0.10.1, Plan B) from Applicant 360: a
 * phone another person has is flagged with the match; confirming they are
 * different people saves it.
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
  for (const [key, name, phone] of [['a', 'Contact Edit Person', '9811155701'], ['b', 'Other Contact Person', '9811155702']]) {
    const r = await api.post('/api/v1/applicants', { headers, data: { name, primaryPhone: phone } });
    expect(r.ok(), await r.text()).toBe(true);
    const body = await r.json();
    ids[key] = body.applicant?.id ?? body.id;
  }
  await api.dispose();
});

test('company_admin edits a contact on Applicant 360; a duplicate phone is flagged and saved only after confirming', async ({ page }) => {
  await login(page, { ...fixture, adminEmail: fixture.roleUsers!.company_admin });
  await page.goto(`/postsales/applicants/${ids.a}`);
  await expect(page.getByRole('heading', { name: 'Contact Edit Person' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit contact' }).click();
  await page.getByLabel('City').fill('Nagpur');
  await page.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByText('Nagpur')).toBeVisible();

  await page.getByRole('button', { name: 'Edit contact' }).click();
  await page.getByLabel('Phone').fill('9811155702');
  await page.getByRole('button', { name: 'Save contact' }).click();
  const warning = page.getByRole('alert');
  await expect(warning).toContainText('Other Contact Person');
  await expect(warning).not.toContainText('9811155702');
  await warning.getByRole('button', { name: /different people/ }).click();
  await expect(page.getByRole('heading', { name: 'Edit contact' })).toHaveCount(0);
  await expect(page.getByText('9811155702')).toBeVisible();
});
