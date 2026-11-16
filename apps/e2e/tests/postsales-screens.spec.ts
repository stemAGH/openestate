import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

/**
 * Post-sales screens found in the 2026-11-12 sweep:
 *  - Applicant 360 links each booking to its installment schedule (before,
 *    the wizard's redirect was the only way there);
 *  - dates read DD-MM-YYYY on Dues, Applicant 360 (ledger, documents) and the
 *    Audit Log;
 *  - Reports offers a role only the reports it may open, and Dues asks for
 *    projects only with the permission: no refused requests;
 *  - the bulk unit form names its price field for what it is.
 */

const fixture = readFixture('postsalesScreens');
const ids: { booking?: string; applicant?: string; registered?: string } = {};
const ISO = /\b20\d\d-\d\d-\d\d\b/;
const SLASH = /\b\d{1,2}\/\d{1,2}\/20\d\d\b/;

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
  const tower = (await call('get', `/projects/${fixture.projectId}/towers?limit=10`)).data[0];
  await call('post', `/projects/${fixture.projectId}/units/bulk-generate`, { towerId: tower.id, floorStart: 50, floorEnd: 50, unitsPerFloor: 2, unitPrefix: 'PS-' });
  const units = await call('get', `/projects/${fixture.projectId}/units?status=AVAILABLE&limit=10`);
  const gst = (await call('get', '/masters/gst-rates?limit=10')).data[0];
  const ap = await call('post', '/applicants', { name: 'Sweep Buyer', primaryPhone: '9811155501' });
  ids.applicant = ap.applicant?.id ?? ap.id;
  const costLines = [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: '500000000', gstRateId: gst.id }];
  const quote = await call('post', '/bookings/quote', { unitId: units.data[0].id, costLines });
  const total = BigInt(quote.agreedPricePaise);
  const booked = await call('post', '/bookings/with-plan', {
    unitId: units.data[0].id, primaryApplicantId: ids.applicant, coApplicantIds: [], bookingDate: '2026-09-01', costLines,
    expectedAgreedPricePaise: quote.agreedPricePaise,
    plan: { mode: 'custom', name: 'Custom Plan', installments: [
      { label: 'Booking amount', dueDate: '2026-09-15', amountPaise: String(total / 10n) },
      { label: 'On possession', dueDate: '2028-03-31', amountPaise: String(total - total / 10n) },
    ] },
  });
  ids.booking = booked.booking.id;
  await call('post', `/bookings/${ids.booking}/documents/statement`, {});
  // A second booking, allotted and registered: the server refuses to cancel it.
  const quote2 = await call('post', '/bookings/quote', { unitId: units.data[1].id, costLines });
  const booked2 = await call('post', '/bookings/with-plan', {
    unitId: units.data[1].id, primaryApplicantId: ids.applicant, coApplicantIds: [], bookingDate: '2026-09-01', costLines,
    expectedAgreedPricePaise: quote2.agreedPricePaise,
    plan: { mode: 'custom', name: 'Custom Plan', installments: [{ label: 'All', dueDate: '2028-03-31', amountPaise: quote2.agreedPricePaise }] },
  });
  ids.registered = booked2.booking.id;
  await call('post', `/bookings/${ids.registered}/allot`, { date: '2026-09-02' });
  await call('post', `/bookings/${ids.registered}/register`, { date: '2026-09-03' });
  await api.dispose();
});

async function signInAs(page: Page, role: string) {
  const email = role === 'super_admin' ? fixture.adminEmail : fixture.roleUsers![role];
  await login(page, { ...fixture, adminEmail: email });
}

/** Records every API request the page makes that the server refuses. */
function refused(page: Page) {
  const out: string[] = [];
  page.on('response', (r) => {
    // The sign-in page's session check (refresh, 401) is expected.
    if (r.url().includes('/api/') && r.status() >= 400 && !r.url().endsWith('/auth/refresh')) out.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
  });
  return out;
}

test('Applicant 360: each booking links to its installment schedule; dates read DD-MM-YYYY', async ({ page }) => {
  await signInAs(page, 'super_admin');
  await page.goto(`/postsales/applicants/${ids.applicant}`);
  // One link per booking (this applicant has two).
  await expect(page.getByRole('link', { name: /installment schedule/i })).toHaveCount(2);
  const link = page.getByRole('link', { name: /installment schedule/i }).and(page.locator(`a[href="/postsales/bookings/${ids.booking}/installments"]`));
  await expect(link).toHaveCount(1);
  // Ledger (booking date) and the generated statement both carry dates.
  await expect(page.getByText('01-09-2026').first()).toBeVisible();
  await expect(page.getByText(/STATEMENT/).first()).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text.match(ISO), 'ISO dates on Applicant 360').toBeNull();
  expect(text.match(SLASH), 'D/M/YYYY dates on Applicant 360').toBeNull();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/postsales/bookings/${ids.booking}/installments$`));
});

test('Dues: due dates read DD-MM-YYYY', async ({ page }) => {
  await signInAs(page, 'company_admin');
  await page.goto('/postsales/dues');
  await expect(page.getByText('15-09-2026')).toBeVisible();
  expect((await page.locator('main tbody').innerText()).match(ISO)).toBeNull();
});

test('Dues: accounts asks for projects only with the permission (no refused requests)', async ({ page }) => {
  const bad = refused(page);
  await signInAs(page, 'accounts');
  await page.goto('/postsales/dues');
  await expect(page.getByRole('heading', { name: 'Dues Dashboard' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  expect(bad.filter((b) => !b.includes('/dashboard') && !b.includes('/my-day'))).toEqual([]);
  await expect(page.locator('main select', { hasText: 'All projects' })).toHaveCount(0);
});

test('Reports: accounts is offered only the reports it may open, and none stays loading', async ({ page }) => {
  const bad = refused(page);
  await signInAs(page, 'accounts');
  await page.goto('/postsales/reports');
  const picker = page.getByRole('combobox', { name: /report/i });
  // The list fills in once the role's permissions have loaded.
  await expect(picker.locator('option')).toHaveCount(4);
  const offered = await picker.locator('option').allTextContents();
  expect(offered).toEqual(['Collection summary', 'Collection — daily', 'Collection — monthly', 'Collection — detail (per receipt)']);
  for (const label of offered) {
    await picker.selectOption({ label });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await expect(page.locator('main')).not.toContainText('Loading…');
  }
  expect(bad.filter((b) => b.includes('/reports/'))).toEqual([]);
});

test('Reports: a report that fails shows an error, not "Loading…" forever', async ({ page }) => {
  await signInAs(page, 'company_admin');
  await page.route('**/api/v1/reports/postsales/project-rollup', (route) => route.fulfill({ status: 500, body: '{"message":"boom"}', contentType: 'application/json' }));
  await page.goto('/postsales/reports');
  await page.getByRole('combobox', { name: /report/i }).selectOption({ label: 'Project-wise rollup' });
  await expect(page.getByRole('alert')).toContainText(/couldn.t load/i);
  await expect(page.locator('main')).not.toContainText('Loading…');
});

test('Audit Log: dates read DD-MM-YYYY HH:mm', async ({ page }) => {
  await signInAs(page, 'super_admin');
  await page.goto('/admin/audit');
  await expect(page.locator('main tbody')).toContainText(/\b\d\d-\d\d-20\d\d \d\d:\d\d/);
  const text = await page.locator('main tbody').innerText();
  expect(text.match(SLASH)).toBeNull();
});

test('Bulk unit form: the price field says it is the price per unit', async ({ page }) => {
  await signInAs(page, 'super_admin');
  await page.goto(`/inventory/projects/${fixture.projectId}`);
  await page.getByRole('button', { name: 'Bulk-Generate Units' }).click();
  await expect(page.getByText('Base price per unit (₹)', { exact: true })).toBeVisible();
  await expect(page.getByText('Base Rate (₹)', { exact: true })).toHaveCount(0);
});

test('Cancel Booking: not offered on a registered booking, nor to a role without the permission', async ({ page }) => {
  await signInAs(page, 'company_admin');
  await page.goto(`/postsales/bookings/${ids.registered}/installments`);
  await expect(page.getByRole('heading', { name: 'Installment Schedule' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await expect(page.getByRole('button', { name: 'Cancel Booking' })).toHaveCount(0);
  await page.context().clearCookies();
  await signInAs(page, 'accounts');
  await page.goto(`/postsales/bookings/${ids.booking}/installments`);
  await expect(page.getByRole('heading', { name: 'Installment Schedule' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await expect(page.getByRole('button', { name: 'Cancel Booking' })).toHaveCount(0);
});

test('Cancel Booking asks first and says what will be posted; "Keep booking" changes nothing', async ({ page }) => {
  const posted: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/cancel')) posted.push(r.url()); });
  await signInAs(page, 'company_admin');
  await page.goto(`/postsales/bookings/${ids.booking}/installments`);
  await page.getByRole('button', { name: 'Cancel Booking' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/BKG\//);
  await expect(dialog).toContainText(/unit .* available/i);
  await expect(dialog).toContainText(/ledger/i);
  await expect(dialog).toContainText(/received so far: ₹0\.00/i);
  await dialog.getByRole('button', { name: 'Keep booking' }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: 'Cancel Booking' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, cancel booking' }).click();
  await expect(page.getByText('This booking has been cancelled.')).toBeVisible();
  expect(posted).toHaveLength(1);
});
