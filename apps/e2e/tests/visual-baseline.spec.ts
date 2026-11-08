import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { istDayBounds } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

// Key screens per staff role at desktop (1440) and phone (390) width:
//  - axe runs every time, and no rule may fire on a screen that didn't fire
//    on it before the design-token change (axe-baseline.json, recorded from
//    the pre-change UI with AXE_RECORD=1). New violations fail; fixed ones
//    are fine.
//  - Full-page screenshots are compared only with VISUAL_SNAPSHOTS=1. The
//    baselines are recorded on Windows (fonts render differently on the
//    Linux CI runners), so CI runs the axe half only. Regenerate with
//    VISUAL_SNAPSHOTS=1 npx playwright test visual-baseline --update-snapshots.

const fixture = readFixture('visual');
const AXE_BASELINE = path.join(__dirname, 'visual-baseline', 'axe-baseline.json');
const record = process.env.AXE_RECORD === '1';
const compareScreens = process.env.VISUAL_SNAPSHOTS === '1';
const baseline: Record<string, string[]> = existsSync(AXE_BASELINE) ? JSON.parse(readFileSync(AXE_BASELINE, 'utf8')) : {};
const recorded: Record<string, string[]> = {};
const ids: { booking?: string; inquiry?: string } = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  // Realistic content through the real API: a booking with a plan and a
  // cheque receipt (accounts screens), inquiries for the executive.
  const api = await playwright.request.newContext({ baseURL: API_URL });
  const signIn = async (email: string) => {
    const res = await api.post('/api/v1/auth/login', { data: { email, password: fixture.adminPassword } });
    expect(res.ok()).toBe(true);
    const csrf = (await api.storageState()).cookies.find((c) => c.name === 'openestate_csrf')!.value;
    return { Authorization: `Bearer ${(await res.json()).accessToken}`, 'X-CSRF-Token': csrf };
  };
  const call = async (headers: Record<string, string>, method: 'get' | 'post', url: string, data?: unknown) => {
    const res = await api[method](`/api/v1${url}`, { headers, data });
    expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  const admin = await signIn(fixture.adminEmail);
  const projects = await call(admin, 'get', '/projects?limit=10');
  const project = projects.data[0];
  const units = await call(admin, 'get', `/projects/${project.id}/units?status=AVAILABLE&limit=10`);
  const gst = (await call(admin, 'get', '/masters/gst-rates?limit=10')).data[0];
  const applicant = await call(admin, 'post', '/applicants', { name: 'Deepak Joshi', primaryPhone: '9123456780', city: 'Pune' });
  const costLines = [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: '8925000000', gstRateId: gst.id }];
  const quote = await call(admin, 'post', '/bookings/quote', { unitId: units.data[0].id, costLines });
  const total = BigInt(quote.agreedPricePaise);
  const first = total / 10n;
  const booked = await call(admin, 'post', '/bookings/with-plan', {
    unitId: units.data[0].id, primaryApplicantId: applicant.applicant?.id ?? applicant.id, coApplicantIds: [],
    bookingDate: '2026-10-15', costLines, expectedAgreedPricePaise: quote.agreedPricePaise,
    plan: { mode: 'custom', name: 'Custom Plan', installments: [
      { label: 'Booking amount', dueDate: '2026-10-20', amountPaise: String(first) },
      { label: 'On possession', dueDate: '2028-03-31', amountPaise: String(total - first) },
    ] },
  });
  ids.booking = booked.booking.id;
  const inst = booked.plan.installments[0];
  await call(admin, 'post', '/receipts', {
    bookingId: booked.booking.id, receiptDate: '2026-10-20', mode: 'CHEQUE', instrumentNumber: '004512', instrumentDate: '2026-10-19',
    grossAmountPaise: String(inst.amountPaise), allocations: [{ installmentId: inst.id, amountPaise: String(inst.amountPaise) }],
  });
  const exec = await signIn(fixture.roleUsers!.sales_executive);
  // Follow-ups at noon IST today and two days ago, so the labels read
  // "Today" and "2 days overdue" on any day (the dates themselves are masked).
  const noonIst = istDayBounds(new Date()).startOfToday.getTime() + 12 * 3_600_000;
  const due = [new Date(noonIst), new Date(noonIst - 2 * 86_400_000), null];
  for (const [i, name] of ['Priya Sharma', 'Arjun Mehta', 'Neha Iyer'].entries()) {
    const inq = await call(exec, 'post', '/inquiries', {
      applicant: { name, primaryPhone: `98765432${10 + i}`, city: 'Pune' },
      projectId: project.id,
      ...(due[i] ? { nextFollowupAt: due[i]!.toISOString() } : {}),
    });
    if (i === 0) ids.inquiry = inq.id;
  }
  await api.dispose();
});

test.afterAll(() => {
  if (record) writeFileSync(AXE_BASELINE, JSON.stringify(recorded, Object.keys(recorded).sort(), 2) + '\n');
});

const SCREENS: Array<{ role: string; name: string; path: () => string }> = [
  { role: 'super_admin', name: 'users', path: () => '/admin/users' },
  { role: 'company_admin', name: 'masters', path: () => '/admin/masters' },
  { role: 'sales_manager', name: 'dashboard', path: () => '/' },
  { role: 'sales_manager', name: 'inquiries', path: () => '/presales/inquiries' },
  { role: 'sales_manager', name: 'inquiry', path: () => `/presales/inquiries/${ids.inquiry}` },
  { role: 'sales_executive', name: 'dashboard', path: () => '/' },
  { role: 'sales_executive', name: 'inquiries', path: () => '/presales/inquiries' },
  { role: 'sales_executive', name: 'inquiry', path: () => `/presales/inquiries/${ids.inquiry}` },
  { role: 'accounts', name: 'installments', path: () => `/postsales/bookings/${ids.booking}/installments` },
  { role: 'accounts', name: 'cheques', path: () => '/postsales/cheques' },
];

async function signInAs(page: Page, role: string) {
  const email = role === 'super_admin' ? fixture.adminEmail : fixture.roleUsers![role];
  await login(page, { ...fixture, adminEmail: email });
}

for (const screen of SCREENS) {
  test(`${screen.role} ${screen.name}: no new axe violations${compareScreens ? ', unchanged screenshots' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInAs(page, screen.role);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(screen.path());
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await expect(page.locator('main h1').first()).toBeVisible();
      const key = `${screen.role} ${screen.name} ${width}`;
      const result = await new AxeBuilder({ page }).analyze();
      const found = [...new Set(result.violations.map((v) => v.id))].sort();
      recorded[key] = found;
      if (!record) {
        const allowed = new Set(baseline[key] ?? []);
        const added = found.filter((id) => !allowed.has(id));
        expect(added, `${key}: new axe violations ${JSON.stringify(result.violations.filter((v) => added.includes(v.id)).map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target) })))}`).toEqual([]);
      }
      if (compareScreens) {
        await expect(page).toHaveScreenshot(`${screen.role}-${screen.name}-${width}.png`, {
          fullPage: true,
          // Run-specific text: e-mail addresses carry the run tag; dates follow today.
          mask: [
            page.getByText(/@e2e-harness\.test/),
            page.getByText(/\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2}/),
            // Prefilled with the current time.
            page.locator('input[type="datetime-local"]'),
          ],
          maxDiffPixelRatio: 0.01,
        });
      }
    }
  });
}
