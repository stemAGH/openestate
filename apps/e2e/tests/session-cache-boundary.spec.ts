/// <reference lib="dom" />
import { test, expect, request, type Page, type Route } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { PERMISSIONS, SESSION_ENDED_MESSAGE } from '@openestate/shared';
import { seedE2eFixture, type E2eFixture } from '../fixtures/seed';
import { currentTotpCode } from '../fixtures/totp';
import { API_URL, DATABASE_URL_SYSTEM } from '../playwright.config';

type Db = ReturnType<typeof createSystemPrismaClient>;
type Account = E2eFixture & { userId: string; marker: string; phone: string };
const duesUrl = '**/api/v1/reports/postsales/installment-dues';
const draftsUrl = '**/api/v1/booking-drafts';
const customersUrl = '**/api/v1/applicants?search=98765&limit=10';

async function account(db: Db, label: string, company?: Account): Promise<Account> {
  const fx = company ?? await seedE2eFixture(DATABASE_URL_SYSTEM);
  const admin = await db.user.findUniqueOrThrow({ where: { companyId_email: { companyId: fx.companyId, email: fx.adminEmail } } });
  const keys = [PERMISSIONS.REPORTS_OUTSTANDING_VIEW, PERMISSIONS.POSTSALES_BOOKING_CREATE,
    PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.POSTSALES_PLAN_READ,
    PERMISSIONS.POSTSALES_RECEIPT_CREATE, PERMISSIONS.PRESALES_APPLICANT_READ];
  const permissions = await db.permission.findMany({ where: { key: { in: keys } } });
  expect(permissions).toHaveLength(keys.length);
  const role = await db.role.create({ data: { companyId: fx.companyId, name: `Cache ${label}`, slug: `cache-${label}`, isSystem: false } });
  await db.rolePermission.createMany({ data: permissions.map(p => ({ roleId: role.id, permissionId: p.id })) });
  const email = `${label}-${fx.adminEmail}`;
  const user = await db.user.create({ data: { companyId: fx.companyId, email, name: `Cache ${label}`,
    roleId: role.id, passwordHash: admin.passwordHash, forcePasswordChange: false } });
  const marker = `Private ${label} ${user.id}`;
  const phone = label === 'A' ? '9876500111' : '9876500222';
  const applicant = await db.applicant.create({ data: { companyId: fx.companyId, name: marker,
    primaryPhone: phone, primaryPhoneNormalized: phone, alternatePhones: [] } });
  await db.bookingDraft.create({ data: { companyId: fx.companyId, createdById: user.id, label: marker,
    draftData: { step: 0, primaryApplicantId: applicant.id, primaryApplicantName: marker,
      coApplicantIds: [], coApplicantNames: [], bookingDate: '2026-10-27', basePricePaise: '',
      planMode: 'template', customInstallments: [] } } });
  const unit = await db.unit.findFirstOrThrow({ where: { companyId: fx.companyId } });
  const booking = await db.booking.create({ data: { companyId: fx.companyId, unitId: unit.id,
    primaryApplicantId: applicant.id, bookingNumber: user.id, createdById: user.id,
    status: 'BOOKED', bookingDate: new Date('2026-01-01'), agreedPricePaise: 1234500n, placeOfSupplyStateCode: '09' } });
  const plan = await db.paymentPlan.create({ data: { companyId: fx.companyId, bookingId: booking.id,
    name: marker, isCustom: true, version: 1 } });
  await db.installment.create({ data: { companyId: fx.companyId, bookingId: booking.id, planId: plan.id,
    seq: 1, label: marker, dueDate: new Date('2026-01-01'), amountPaise: 1234500n } });
  return { ...fx, adminEmail: email, userId: user.id, marker, phone };
}

async function signIn(page: Page, who: Account, first = false, secret?: string) {
  if (first) await page.goto('/login');
  await page.locator('#email').fill(who.adminEmail);
  await page.locator('#password').fill(who.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (secret) {
    await expect(page.getByRole('heading', { name: 'Two-Factor Authentication' })).toBeVisible();
    await noLeaks(page);
    await page.locator('#code').fill(currentTotpCode(secret));
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/$/);
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}
async function open(page: Page, name: string) {
  const section = page.getByRole('button', { name: 'Post-Sales', exact: true });
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
  await page.getByRole('link', { name, exact: true }).click();
}
async function watch(page: Page, forbidden: string[]) {
  await page.evaluate((values) => {
    const state = window as typeof window & { cacheLeaks: string[] };
    state.cacheLeaks = [];
    const check = () => {
      const content = document.body.textContent ?? '';
      for (const value of values) if (content.includes(value)) state.cacheLeaks.push(value);
    };
    check();
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, forbidden);
}
async function noLeaks(page: Page) {
  expect(await page.evaluate(() => (window as typeof window & { cacheLeaks: string[] }).cacheLeaks)).toEqual([]);
}
async function hold(page: Page, url: string) {
  let release!: () => void;
  let captured = false;
  let delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url, async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (!captured) {
      captured = true;
      await gate;
      await route.fulfill({ response });
      delivered = true;
    } else await route.fulfill({ response });
  });
  return { release, captured: () => captured, delivered: () => delivered };
}
async function control(who: E2eFixture) {
  const client = await request.newContext({ baseURL: API_URL });
  const res = await client.post('/api/v1/auth/login', { data: { email: who.adminEmail, password: who.adminPassword } });
  expect(res.status()).toBe(200);
  const csrf = (await client.storageState()).cookies.find(c => c.name === 'openestate_csrf')!.value;
  return { client, headers: { Authorization: `Bearer ${(await res.json()).accessToken}`, 'X-CSRF-Token': csrf } };
}

// Harness fixtures are deliberately retained in the dedicated test database, like seed.ts.
// Cleanup releases network gates and connections; it never resets a database or deletes other fixtures.
for (const scenario of ['financial data', 'booking drafts', 'customer details', 'same-company drafts', '2FA financial data']) {
  test(`same-tab boundary: ${scenario}`, async ({ page }) => {
    const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
    let release = () => {};
    try {
      const a = await account(db, 'A');
      const b = await account(db, 'B', scenario === 'same-company drafts' ? a : undefined);
      let secret: string | undefined;
      if (scenario.startsWith('2FA')) {
        const c = await control(b);
        try {
          const setup = await c.client.post('/api/v1/auth/totp/setup', { headers: c.headers });
          expect(setup.ok()).toBe(true);
          secret = (await setup.json()).secret;
          const confirmed = await c.client.post('/api/v1/auth/totp/confirm', { headers: c.headers, data: { code: currentTotpCode(secret!) } });
          expect(confirmed.ok()).toBe(true);
        } finally { await c.client.dispose(); }
      }
      const drafts = scenario.includes('drafts');
      const customers = scenario === 'customer details';
      const label = drafts ? 'New Booking' : customers ? 'Receipt Entry' : 'Dues Dashboard';
      await signIn(page, a, true);
      await open(page, label);
      if (drafts) await page.getByRole('button', { name: /Resume/ }).click();
      if (customers) await page.getByPlaceholder('98765xxxxx').fill('98765');
      await expect(page.getByText(a.marker, { exact: false }).first()).toBeVisible();
      await signOut(page);
      await watch(page, [a.marker, ...(customers ? [a.phone] : [])]);
      const pending = await hold(page, drafts ? draftsUrl : customers ? customersUrl : duesUrl);
      release = pending.release;
      await signIn(page, b, false, secret);
      await open(page, label);
      if (customers) await page.getByPlaceholder('98765xxxxx').fill('98765');
      if (drafts) await expect(page.getByRole('button', { name: /Resume/ })).toHaveCount(0);
      else await expect(page.getByText(a.marker, { exact: false })).toHaveCount(0);
      await expect.poll(pending.captured).toBe(true);
      await noLeaks(page);
      pending.release();
      if (drafts) await page.getByRole('button', { name: /Resume/ }).click();
      await expect(page.getByText(b.marker, { exact: false }).first()).toBeVisible();
      await noLeaks(page);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
  });
}

test('late A financial response cannot populate B after same-tab login', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  let release = () => {};
  try {
    const a = await account(db, 'A');
    const b = await account(db, 'B');
    await signIn(page, a, true);
    const pending = await hold(page, duesUrl);
    release = pending.release;
    await open(page, 'Dues Dashboard');
    await expect.poll(pending.captured).toBe(true);
    await signOut(page);
    await watch(page, [a.marker]);
    await signIn(page, b);
    await open(page, 'Dues Dashboard');
    pending.release();
    await expect.poll(pending.delivered).toBe(true);
    await expect(page.getByText(b.marker, { exact: false }).first()).toBeVisible();
    await noLeaks(page);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
});

test('forced session end discards cached drafts and local form state before B signs in', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const admin = await seedE2eFixture(DATABASE_URL_SYSTEM);
    // Keep a separate real administrator solely to deactivate the restricted user.
    const a = await account(db, 'A', { ...admin, userId: '', marker: '', phone: '' });
    const b = await account(db, 'B');
    await signIn(page, a, true);
    await open(page, 'New Booking');
    await page.getByRole('button', { name: /Resume/ }).click();
    await expect(page.getByText(a.marker, { exact: false })).toBeVisible();
    const c = await control(admin);
    try {
      const ended = await c.client.post(`/api/v1/users/${a.userId}/deactivate`, { headers: c.headers });
      expect(ended.ok()).toBe(true);
    } finally { await c.client.dispose(); }
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('status')).toHaveText(SESSION_ENDED_MESSAGE);
    await watch(page, [a.marker]);
    await signIn(page, b);
    await open(page, 'New Booking');
    await page.getByRole('button', { name: /Resume/ }).click();
    await expect(page.getByText(b.marker, { exact: false })).toBeVisible();
    await noLeaks(page);
  } finally { await db.$disconnect(); }
});

async function challengeNextCustomerRequest(page: Page) {
  let challenged = false;
  await page.route(customersUrl, async route => {
    if (challenged) return route.continue();
    challenged = true;
    // Obtain a real backend 401, exercising api()'s normal refresh/retry path.
    const response = await route.fetch({ headers: { ...route.request().headers(), authorization: 'Bearer expired-test-token' } });
    expect(response.status()).toBe(401);
    await route.fulfill({ response });
  });
}

test('same-session refresh preserves form state and retries the real customer lookup', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const a = await account(db, 'A');
    await signIn(page, a, true);
    await open(page, 'Receipt Entry');
    await challengeNextCustomerRequest(page);
    const refreshed = page.waitForResponse(r => r.url().endsWith('/auth/refresh') && r.status() === 200);
    await page.getByPlaceholder('98765xxxxx').fill('98765');
    await refreshed;
    await expect(page.getByText(a.marker, { exact: false })).toBeVisible();
    await expect(page.getByPlaceholder('98765xxxxx')).toHaveValue('98765');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
});

test('a delayed A refresh cannot replace B authentication or B financial data', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  let release = () => {};
  try {
    const a = await account(db, 'A');
    const b = await account(db, 'B');
    await signIn(page, a, true);
    await open(page, 'Receipt Entry');
    await challengeNextCustomerRequest(page);
    const pending = await hold(page, '**/api/v1/auth/refresh');
    release = pending.release;
    await page.getByPlaceholder('98765xxxxx').fill('98765');
    await expect.poll(pending.captured).toBe(true);
    await signOut(page);
    await watch(page, [a.marker, a.phone]);
    await signIn(page, b);
    pending.release();
    await expect.poll(pending.delivered).toBe(true);
    await open(page, 'Dues Dashboard');
    await expect(page.getByText(b.marker, { exact: false }).first()).toBeVisible();
    await noLeaks(page);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
});
