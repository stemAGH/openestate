/// <reference lib="dom" />
import { randomInt, randomUUID } from 'node:crypto';
import { test, expect, request, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { seedE2eFixture, type E2eFixture } from '../fixtures/seed';
import { controlAfterLabel } from '../fixtures/actions';
import { currentTotpCode } from '../fixtures/totp';
import { API_URL, PORTAL_URL, DATABASE_URL_SYSTEM } from '../playwright.config';

type Db = ReturnType<typeof createSystemPrismaClient>;
type Account = { fx: E2eFixture; id: string; email: string; phone: string; marker: string; booking: string; kind: 'staff' | 'customer' | 'broker' };
async function account(db: Db, label: string, kind: Account['kind'] = 'customer', company?: Account): Promise<Account> {
  const fx = company?.fx ?? await seedE2eFixture(DATABASE_URL_SYSTEM);
  const admin = await db.user.findUniqueOrThrow({ where: { companyId_email: { companyId: fx.companyId, email: fx.adminEmail } } });
  const marker = `Private ${label} ${randomUUID()}`;
  const phone = `9${randomInt(100000000, 1000000000)}`;
  const email = `${randomUUID()}@session-test.invalid`;
  const booking = randomUUID();
  if (kind === 'staff') return { fx, id: admin.id, email: fx.adminEmail, phone, marker, booking, kind };
  const slug = kind === 'broker' ? SYSTEM_ROLES.BROKER : SYSTEM_ROLES.CUSTOMER;
  let role = await db.role.findUnique({ where: { companyId_slug: { companyId: fx.companyId, slug } } });
  if (!role) {
    role = await db.role.create({ data: { companyId: fx.companyId, name: slug, slug, isPortal: true, isSystem: true } });
    const permissions = await db.permission.findMany({ where: { key: { in: [...ROLE_PERMISSIONS[slug]] } } });
    await db.rolePermission.createMany({ data: permissions.map(p => ({ roleId: role!.id, permissionId: p.id })) });
  }
  const principal = kind === 'broker'
    ? await db.broker.create({ data: { companyId: fx.companyId, name: marker, phone, email } })
    : await db.applicant.create({ data: { companyId: fx.companyId, name: marker, primaryPhone: phone, primaryPhoneNormalized: phone, email } });
  const user = await db.user.create({ data: { companyId: fx.companyId, name: marker, email, phone,
    passwordHash: admin.passwordHash, roleId: role.id, forcePasswordChange: false,
    ...(kind === 'broker' ? { brokerId: principal.id } : { applicantId: principal.id }) } });
  if (kind === 'customer') {
    const unit = await db.unit.findFirstOrThrow({ where: { companyId: fx.companyId } });
    await db.booking.create({ data: { companyId: fx.companyId, unitId: unit.id, primaryApplicantId: principal.id,
      bookingNumber: booking, status: 'BOOKED', agreedPricePaise: 1234500n, bookingDate: new Date('2026-01-01'), createdById: admin.id } });
  }
  return { fx, id: user.id, email, phone, marker, booking, kind };
}
async function signIn(page: Page, who: Account, first = false, secret?: string) {
  const staff = who.kind === 'staff';
  if (first) await page.goto(staff ? '/login' : `${PORTAL_URL}/portal/login`);
  await page.locator(staff ? '#email' : '#identifier').fill(who.email);
  await page.locator('#password').fill(who.fx.adminPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (secret) {
    await page.locator('#totp').fill(currentTotpCode(secret));
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
  }
  await expect(page).toHaveURL(staff ? /\/$/ : who.kind === 'broker' ? /\/portal\/broker\/dashboard$/ : /\/portal\/profile$/);
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}
async function watch(page: Page, a: Account) {
  await page.evaluate(values => {
    const state = window as typeof window & { leaks: string[] };
    state.leaks = [];
    const check = () => {
      const content = (document.body.textContent ?? '') + Array.from(document.querySelectorAll('input, textarea')).map(e => (e as HTMLInputElement).value).join(' ');
      for (const value of values) if (content.includes(value)) state.leaks.push(value);
    };
    check();
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    document.addEventListener('input', check);
  }, [a.marker, a.phone, a.email, a.booking]);
}
async function noLeaks(page: Page) {
  expect(await page.evaluate(() => (window as typeof window & { leaks: string[] }).leaks)).toEqual([]);
}
async function hold(page: Page, url: string) {
  let release!: () => void;
  let captured = false;
  let delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (!captured) { captured = true; await gate; await route.fulfill({ response }); delivered = true; }
    else await route.fulfill({ response });
  });
  return { release, captured: () => captured, delivered: () => delivered };
}
async function control(who: Account, portal = false) {
  const client = await request.newContext({ baseURL: API_URL });
  const response = await client.post(portal ? '/api/v1/portal/auth/login' : '/api/v1/auth/login', {
    data: portal ? { identifier: who.email, password: who.fx.adminPassword } : { email: who.fx.adminEmail, password: who.fx.adminPassword },
  });
  expect(response.status()).toBe(200);
  const csrf = (await client.storageState()).cookies.find(c => c.name === (portal ? 'openestate_portal_csrf' : 'openestate_csrf'))!.value;
  return { client, headers: { Authorization: `Bearer ${(await response.json()).accessToken}`, 'X-CSRF-Token': csrf } };
}

// Own fixtures are retained in the dedicated test DB, matching seed.ts; no global cleanup.
for (const scenario of ['profile', 'financial', 'same-company', '2FA', 'broker']) {
  test(`portal privacy boundary: ${scenario}`, async ({ page }) => {
    const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
    let release = () => {};
    try {
      const a = await account(db, 'A', scenario === 'broker' ? 'broker' : 'customer');
      const b = await account(db, 'B', a.kind, scenario === 'same-company' ? a : undefined);
      let secret: string | undefined;
      if (scenario === '2FA') {
        const c = await control(b, true);
        try {
          const setup = await c.client.post('/api/v1/portal/auth/totp/setup', { headers: c.headers });
          expect(setup.ok()).toBe(true); secret = (await setup.json()).secret;
          expect((await c.client.post('/api/v1/portal/auth/totp/confirm', { headers: c.headers, data: { code: currentTotpCode(secret!) } })).ok()).toBe(true);
        } finally { await c.client.dispose(); }
      }
      const financial = scenario === 'financial';
      const endpoint = financial ? 'account' : scenario === 'broker' ? 'broker/dashboard' : 'profile';
      await signIn(page, a, true);
      if (financial) await page.getByRole('link', { name: /Account/ }).click();
      await expect(page.getByText(financial ? a.booking : a.marker, { exact: true })).toBeVisible();
      if (!financial && a.kind === 'customer') await page.getByPlaceholder('New email address').fill(`private-${a.email}`);
      await signOut(page);
      await watch(page, a);
      const gate = await hold(page, `**/api/v1/portal/${endpoint}`); release = gate.release;
      await signIn(page, b, false, secret);
      if (financial) await page.getByRole('link', { name: /Account/ }).click();
      await expect(page.getByText(financial ? a.booking : a.marker, { exact: true })).toHaveCount(0);
      await expect.poll(gate.captured).toBe(true);
      await noLeaks(page);
      gate.release();
      await expect(page.getByText(financial ? b.booking : b.marker, { exact: true })).toBeVisible();
      await noLeaks(page);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
  });
}

test('portal privacy boundary: late A financial response', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM); let release = () => {};
  try {
    const a = await account(db, 'A'); const b = await account(db, 'B');
    await signIn(page, a, true);
    const gate = await hold(page, '**/api/v1/portal/account'); release = gate.release;
    await page.getByRole('link', { name: /Account/ }).click();
    await expect.poll(gate.captured).toBe(true);
    await signOut(page); await watch(page, a); await signIn(page, b);
    await page.getByRole('link', { name: /Account/ }).click();
    gate.release(); await expect.poll(gate.delivered).toBe(true);
    await expect(page.getByText(b.booking, { exact: true })).toBeVisible(); await noLeaks(page);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
});

test('portal privacy boundary: forced end removes customer state', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const a = await account(db, 'A'); const b = await account(db, 'B');
    await signIn(page, a, true); await expect(page.getByText(a.marker, { exact: true })).toBeVisible();
    await page.getByPlaceholder('New email address').fill(`private-${a.email}`);
    const c = await control(a);
    try { expect((await c.client.post(`/api/v1/users/${a.id}/deactivate`, { headers: c.headers })).ok()).toBe(true); }
    finally { await c.client.dispose(); }
    await page.getByRole('link', { name: /Security/ }).click();
    await expect(page).toHaveURL(/\/portal\/login$/);
    await expect(page.getByRole('status')).toBeVisible();
    await watch(page, a); await signIn(page, b);
    await expect(page.getByText(b.marker, { exact: true })).toBeVisible(); await noLeaks(page);
  } finally { await db.$disconnect(); }
});

test('portal same-identity refresh preserves the active mutation form', async ({ page }) => {
  const db = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const a = await account(db, 'A'); await signIn(page, a, true);
    let first = true;
    await page.route('**/api/v1/portal/profile/change-requests', async route => {
      if (!first) return route.continue(); first = false;
      const response = await route.fetch({ headers: { ...route.request().headers(), authorization: 'Bearer expired-test-token' } });
      expect(response.status()).toBe(401); await route.fulfill({ response });
    });
    const refreshed = page.waitForResponse(r => r.url().endsWith('/portal/auth/refresh') && r.status() === 200);
    await page.getByPlaceholder('New email address').fill('updated@session-test.invalid');
    await page.getByRole('button', { name: 'Submit', exact: true }).click(); await refreshed;
    await expect(page.getByText(/Request submitted/)).toBeVisible();
    await expect(page.getByText(a.marker, { exact: true })).toBeVisible();
  } finally { await page.unrouteAll({ behavior: 'wait' }); await db.$disconnect(); }
});

for (const kind of ['staff', 'customer'] as const) for (const method of ['GET', 'POST']) {
  test(`${kind} two-tab refresh refuses cross-account ${method} replay`, async ({ page, context }) => {
    const db = createSystemPrismaClient(DATABASE_URL_SYSTEM); const second = await context.newPage();
    try {
      const a = await account(db, 'A', kind); const b = await account(db, 'B', kind);
      await signIn(page, a, true);
      if (kind === 'staff' && method === 'POST') await page.goto('/admin/custom-fields');
      if (kind === 'customer') await expect(page.getByText(a.marker, { exact: true })).toBeVisible();
      // The second tab first restores A from the shared cookie, then explicitly switches to B.
      await second.goto(kind === 'staff' ? '/' : `${PORTAL_URL}/portal/`);
      await expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await signOut(second); await signIn(second, b);
      if (kind === 'customer') {
        // Isolate refresh identity from the separately tested same-tab cache defect.
        await second.reload();
        await expect(second.getByText(b.marker, { exact: true })).toBeVisible();
      }
      const endpoint = kind === 'staff' ? (method === 'GET' ? '/auth/me' : '/custom-fields')
        : (method === 'GET' ? '/portal/account' : '/portal/profile/change-requests');
      const replays: string[] = []; let challenged = false;
      await page.route(`**/api/v1${endpoint}`, async route => {
        if (route.request().method() !== method) return route.continue();
        if (challenged) {
          const bearer = route.request().headers().authorization;
          replays.push(JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub);
          // Detect a prohibited write without allowing it to persist in B's company.
          return route.abort();
        }
        challenged = true;
        const response = await route.fetch({ headers: { ...route.request().headers(), authorization: 'Bearer expired-test-token' } });
        expect(response.status()).toBe(401); await route.fulfill({ response });
      });
      const refreshed = page.waitForResponse(r => r.url().endsWith(kind === 'staff' ? '/auth/refresh' : '/portal/auth/refresh') && r.status() === 200);
      if (method === 'GET') await page.getByRole('link', { name: kind === 'staff' ? 'Settings' : /Account/, exact: kind === 'staff' }).click();
      else if (kind === 'customer') {
        await page.getByPlaceholder('New email address').fill('obsolete-a@session-test.invalid');
        await page.getByRole('button', { name: 'Submit', exact: true }).click();
      } else {
        await page.getByRole('button', { name: /Add.*Field/ }).click();
        await controlAfterLabel(page, 'Field Name').fill(`session_${randomUUID().replace(/-/g, '')}`);
        await controlAfterLabel(page, 'Label').fill(a.marker);
        await page.getByRole('button', { name: 'Create Field', exact: true }).click();
      }
      const returned = (await (await refreshed).json()).accessToken as string;
      expect(JSON.parse(Buffer.from(returned.split('.')[1], 'base64url').toString()).sub).toBe(b.id);
      await expect.poll(() => replays.length > 0 || /\/login$/.test(page.url())).toBe(true);
      if (replays.length) expect(replays).toContain(b.id);
      expect(replays).toEqual([]);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('status')).toBeVisible();
      // A's mismatch must not revoke or clear B's shared refresh cookie.
      await second.reload();
      await expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      if (kind === 'customer') await expect(second.getByText(b.marker, { exact: true })).toBeVisible();
      await signIn(page, a);
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    } finally { await page.unrouteAll({ behavior: 'wait' }); await second.close(); await db.$disconnect(); }
  });
}
