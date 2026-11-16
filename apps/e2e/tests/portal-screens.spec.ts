import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFixture } from '../fixtures/state';
import { createSystemPrismaClient } from '@openestate/db';
import { ROLE_DISPLAY_NAMES, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@openestate/shared';
import { API_URL, DATABASE_URL_SYSTEM, PORTAL_URL } from '../playwright.config';

/**
 * Portal screens found in the 2026-11-12 sweep:
 *  - a broker opening a customer page (or a customer a broker page) is sent
 *    to their own home, instead of a page stuck on "Loading…" behind a
 *    refused request;
 *  - dates read DD-MM-YYYY;
 *  - Security's inputs have labels, and text meets the contrast minimum.
 */

const fixture = readFixture('portalScreens');
const broker = { phone: '9811188801', password: 'Broker-portal-pass-1' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  // The fixture seeds the customer portal role only; add the broker one, the same way.
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const role = await prisma.role.create({
      data: { companyId: fixture.companyId, name: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.BROKER], slug: SYSTEM_ROLES.BROKER, isSystem: true, isPortal: true },
    });
    const perms = await prisma.permission.findMany({ where: { key: { in: [...ROLE_PERMISSIONS[SYSTEM_ROLES.BROKER]] } } });
    await prisma.rolePermission.createMany({ data: perms.map((p: { id: string }) => ({ roleId: role.id, permissionId: p.id })) });
  } finally {
    await prisma.$disconnect();
  }
  const api = await playwright.request.newContext({ baseURL: API_URL });
  const res = await api.post('/api/v1/auth/login', { data: { email: fixture.adminEmail, password: fixture.adminPassword } });
  expect(res.ok()).toBe(true);
  const csrf = (await api.storageState()).cookies.find((c) => c.name === 'openestate_csrf')!.value;
  const headers = { Authorization: `Bearer ${(await res.json()).accessToken}`, 'X-CSRF-Token': csrf };
  const call = async (url: string, data: unknown) => {
    const r = await api.post(`/api/v1${url}`, { headers, data });
    expect(r.ok(), `${url}: ${await r.text()}`).toBe(true);
    return r.json();
  };
  // A generated statement gives the customer's account page a dated document.
  const found = await (await api.get(`/api/v1/applicants?search=${fixture.portalIdentifier}&limit=5`, { headers })).json();
  const view = await (await api.get(`/api/v1/applicants/${found.data[0].id}/360`, { headers })).json();
  await call(`/bookings/${view.bookings[0].id}/documents/statement`, {});
  const b = await call('/brokers', { name: 'Portal Screens Broker', phone: broker.phone });
  const invite = await call('/admin/portal-invites', { brokerId: b.id, channel: 'SMS' });
  const consumed = await api.post(`/api/v1/portal/auth/invite/${invite.inviteId}/consume`, { data: { token: invite.token, password: broker.password } });
  expect(consumed.ok(), await consumed.text()).toBe(true);
  await api.dispose();
});

async function signIn(page: Page, identifier: string, password: string) {
  await page.goto(`${PORTAL_URL}/portal/login`);
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith('/login'));
}

function refused(page: Page) {
  const out: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && !r.url().endsWith('/auth/refresh')) out.push(`${new URL(r.url()).pathname} -> ${r.status()}`);
  });
  return out;
}

async function axe(page: Page, rules: string[]) {
  const result = await new AxeBuilder({ page }).withRules(rules).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

test('customer: account dates read DD-MM-YYYY; broker pages send the customer home', async ({ page }) => {
  const bad = refused(page);
  await signIn(page, fixture.portalIdentifier!, fixture.portalPassword!);
  await page.goto(`${PORTAL_URL}/portal/account`);
  await expect(page.getByRole('heading', { name: 'My Account' })).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).toMatch(/\b\d\d-\d\d-20\d\d\b/);
  expect(text.match(/\b\d{1,2}\/\d{1,2}\/20\d\d\b/), 'D/M/YYYY dates').toBeNull();
  for (const p of ['/broker/dashboard', '/broker/nocs', '/broker/statement']) {
    await page.goto(`${PORTAL_URL}/portal${p}`);
    await expect(page).toHaveURL(/\/portal\/profile$/);
  }
  expect(bad).toEqual([]);
});

test('broker: customer pages send the broker home, with no refused requests', async ({ page }) => {
  const bad = refused(page);
  await signIn(page, broker.phone, broker.password);
  for (const p of ['/profile', '/property', '/account']) {
    await page.goto(`${PORTAL_URL}/portal${p}`);
    await expect(page).toHaveURL(/\/portal\/broker\/dashboard$/);
  }
  await expect(page.locator('main')).not.toContainText('Loading…');
  expect(bad).toEqual([]);
});

test('accessibility: labelled inputs and enough contrast on Security, Support, NOCs and Statements', async ({ page, browser }) => {
  await signIn(page, fixture.portalIdentifier!, fixture.portalPassword!);
  const found: string[] = [];
  for (const p of ['/security', '/tickets', '/account']) {
    await page.goto(`${PORTAL_URL}/portal${p}`);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    found.push(...(await axe(page, ['label', 'color-contrast'])).map((v) => `customer ${p} ${v}`));
  }
  const ctx = await browser.newContext();
  const bp = await ctx.newPage();
  await signIn(bp, broker.phone, broker.password);
  for (const p of ['/broker/nocs', '/broker/statement', '/tickets', '/security']) {
    await bp.goto(`${PORTAL_URL}/portal${p}`);
    await bp.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    found.push(...(await axe(bp, ['label', 'color-contrast'])).map((v) => `broker ${p} ${v}`));
  }
  await ctx.close();
  expect(found).toEqual([]);
});
