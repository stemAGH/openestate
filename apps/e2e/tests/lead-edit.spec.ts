import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

/**
 * Editing a lead's details (v0.10.1, Plan A): a sales executive edits the
 * budget on their own lead from Inquiry Detail; an out-of-order range is
 * caught before saving; nothing the role can't read is requested.
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
  const lead = await api.post('/api/v1/inquiries', { headers, data: { applicant: { name: 'Edit Me Lead', primaryPhone: '9811155601' } } });
  expect(lead.ok(), await lead.text()).toBe(true);
  ids.lead = (await lead.json()).id;
  const users = await (await api.get('/api/v1/users?limit=100', { headers })).json();
  const exec = users.data.find((u: { email: string }) => u.email === fixture.roleUsers!.sales_executive);
  const assign = await api.patch(`/api/v1/inquiries/${ids.lead}/assign`, { headers, data: { toUserId: exec.id, reason: 'test' } });
  expect(assign.ok(), await assign.text()).toBe(true);
  await api.dispose();
});

function refused(page: Page) {
  const out: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && !r.url().includes('/auth/refresh')) out.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
  });
  return out;
}

test('sales_executive edits the budget on their own lead; an out-of-order range is caught first', async ({ page }) => {
  await login(page, { ...fixture, adminEmail: fixture.roleUsers!.sales_executive });
  const bad = refused(page);
  await page.goto(`/presales/inquiries/${ids.lead}`);
  await expect(page.getByRole('heading', { name: 'Edit Me Lead' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit details' }).click();
  await page.getByLabel('Budget min (₹)').fill('50000');
  await page.getByLabel('Budget max (₹)').fill('40000');
  await expect(page.getByText('Budget max is below budget min.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save details' })).toBeDisabled();
  await page.getByLabel('Budget max (₹)').fill('90000');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByTestId('lead-budget')).toHaveText('₹50,000.00 to ₹90,000.00');
  await page.reload();
  await expect(page.getByTestId('lead-budget')).toHaveText('₹50,000.00 to ₹90,000.00');
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  expect(bad).toEqual([]);
});
