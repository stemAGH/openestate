import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

/**
 * Screens a role can open no longer ask for data the role can't read (the
 * server refused those requests silently, found in the 2026-11-12 sweep);
 * the section that needs the data is not shown instead. And an inquiry the
 * user can't see says so, rather than "Loading…" for ever.
 */

const fixture = readFixture('roleScreens');
const ids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: API_URL });
  const res = await api.post('/api/v1/auth/login', { data: { email: fixture.adminEmail, password: fixture.adminPassword } });
  expect(res.ok()).toBe(true);
  const csrf = (await api.storageState()).cookies.find((c) => c.name === 'openestate_csrf')!.value;
  const headers = { Authorization: `Bearer ${(await res.json()).accessToken}`, 'X-CSRF-Token': csrf };
  const call = async (method: 'get' | 'post', url: string, data?: unknown) => {
    const r = await api[method](`/api/v1${url}`, { headers, data });
    expect(r.ok(), `${method} ${url}: ${await r.text()}`).toBe(true);
    return r.json();
  };
  ids.broker = (await call('post', '/brokers', { name: 'Role Screens Broker', phone: '9811166601' })).id;
  const units = await call('get', `/projects/${fixture.projectId}/units?status=AVAILABLE&limit=10`);
  const gst = (await call('get', '/masters/gst-rates?limit=10')).data[0];
  const ap = await call('post', '/applicants', { name: 'Role Buyer', primaryPhone: '9811166602' });
  ids.applicant = ap.applicant?.id ?? ap.id;
  const costLines = [{ kind: 'BASE', label: 'Base', baseAmountPaise: '100000000', gstRateId: gst.id }];
  const quote = await call('post', '/bookings/quote', { unitId: units.data[0].id, costLines });
  const booked = await call('post', '/bookings/with-plan', {
    unitId: units.data[0].id, primaryApplicantId: ids.applicant, coApplicantIds: [], bookingDate: '2026-11-12', costLines,
    expectedAgreedPricePaise: quote.agreedPricePaise,
    plan: { mode: 'custom', name: 'Custom Plan', installments: [{ label: 'All', dueDate: '2027-03-31', amountPaise: quote.agreedPricePaise }] },
  });
  ids.booking = booked.booking.id;
  // A lead owned by the admin: not in the executive's team.
  ids.inquiry = (await call('post', '/inquiries', { applicant: { name: 'Admin Lead', primaryPhone: '9811166603' } })).id;
  const users = await call('get', '/users?limit=100');
  ids.execUser = users.data.find((u: { email: string }) => u.email === fixture.roleUsers!.sales_executive).id;
  await api.dispose();
});

async function signInAs(page: Page, role: string) {
  await login(page, { ...fixture, adminEmail: fixture.roleUsers![role] });
}

/** Every API request the page makes that the server refuses. */
function refused(page: Page) {
  const out: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) out.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
  });
  return out;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
}

test('sales_executive: project, Applicant 360 and schedule ask for nothing the role can’t read', async ({ page }) => {
  const bad = refused(page);
  await signInAs(page, 'sales_executive');
  await page.goto(`/inventory/projects/${fixture.projectId}`);
  await expect(page.getByRole('heading', { name: 'Towers' })).toBeVisible();
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Construction Updates' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Construction Stages' })).toHaveCount(0);
  await page.goto(`/postsales/applicants/${ids.applicant}`);
  await expect(page.getByRole('heading', { name: 'Bookings' })).toBeVisible();
  await settle(page);
  await expect(page.getByRole('link', { name: /installment schedule/i })).toHaveCount(0);
  await page.goto(`/postsales/bookings/${ids.booking}/installments`);
  await expect(page.getByText("Your role can't see this booking's payment plan.")).toBeVisible();
  await settle(page);
  expect(bad.filter((b) => !b.includes('/auth/refresh'))).toEqual([]);
});

test('sales_manager: project, broker and user pages ask for nothing the role can’t read', async ({ page }) => {
  const bad = refused(page);
  await signInAs(page, 'sales_manager');
  await page.goto(`/inventory/projects/${fixture.projectId}`);
  await expect(page.getByRole('heading', { name: 'Construction Updates' })).toBeVisible();
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Construction Stages' })).toHaveCount(0);
  await page.goto(`/postsales/brokers/${ids.broker}`);
  await expect(page.getByRole('heading', { name: 'Commission Rules' })).toBeVisible();
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Commission', exact: true })).toHaveCount(0);
  await page.goto(`/admin/users/${ids.execUser}`);
  await settle(page);
  await expect(page.locator('select[name="roleId"] option:checked')).toHaveText(/sales_executive|Sales Executive/i);
  expect(bad.filter((b) => !b.includes('/auth/refresh'))).toEqual([]);
});

test('an inquiry the user can’t see says so, with a way back', async ({ page }) => {
  await signInAs(page, 'sales_executive');
  await page.goto(`/presales/inquiries/${ids.inquiry}`);
  await expect(page.getByRole('heading', { name: 'Inquiry not available' })).toBeVisible();
  await expect(page.getByText("isn't assigned to you or your team")).toBeVisible();
  await page.getByRole('link', { name: 'Back to Inquiries' }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries$/);
});

// QA-007: accounts holds receipt.create but no pre-sales permission, so the
// payer search used to be refused and no receipt could be recorded.
test('accounts: records a receipt from Receipt Entry, finding the payer without pre-sales access', async ({ page }) => {
  await signInAs(page, 'accounts');
  await settle(page);
  const bad = refused(page); // from Receipt Entry on (the landing dashboard is QA-034)
  await page.goto('/postsales/receipts/new');
  // The first field on the form (its label changed with the fix; the lookup is what's tested).
  await page.getByRole('textbox').first().fill('9811166602');
  const suggestion = page.getByRole('button', { name: /Role Buyer/ });
  await expect(suggestion).toBeVisible();
  await expect(suggestion).not.toContainText('9811166602');
  await suggestion.click();
  await expect(page.getByRole('combobox').first()).toHaveValue(ids.booking);
  await expect(page.getByRole('link', { name: 'View ledger' })).toHaveCount(0);
  await page.locator('input[type="number"]').first().fill('1000');
  await page.getByRole('button', { name: 'Auto-fill oldest-dues-first' }).click();
  await page.getByRole('button', { name: 'Save & Print Receipt' }).click();
  await expect(page.getByText(/Receipt RCP\/\d{4}-\d{2}\/\d{6} saved\./)).toBeVisible();
  await settle(page);
  expect(bad).toEqual([]);
});
