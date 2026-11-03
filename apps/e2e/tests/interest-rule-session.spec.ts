/// <reference lib="dom" />
import { test, expect, request, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { PERMISSIONS } from '@openestate/shared';
import { seedE2eFixture, type E2eFixture } from '../fixtures/seed';
import { login } from '../fixtures/actions';
import { API_URL, DATABASE_URL_SYSTEM } from '../playwright.config';

const lookup = '**/api/v1/bookings/interest-rules/attachable';
const draftData = { step: 4, coApplicantIds: [], coApplicantNames: [], bookingDate: '2026-10-24',
  basePricePaise: '', planMode: 'template', customInstallments: [] };
type Client = ReturnType<typeof createSystemPrismaClient>;

async function accounts(prisma: Client, fixture: E2eFixture) {
  const keys = [PERMISSIONS.POSTSALES_INTEREST_MANAGE, PERMISSIONS.POSTSALES_BOOKING_CREATE,
    PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.POSTSALES_PLAN_READ];
  const permissions = await prisma.permission.findMany({ where: { key: { in: keys } } });
  expect(permissions).toHaveLength(keys.length);
  const role = await prisma.role.create({ data: {
    companyId: fixture.companyId, name: 'Session Accounts', slug: 'session-accounts', isSystem: false,
  } });
  await prisma.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  const user = await prisma.user.update({ where: { companyId_email: {
    companyId: fixture.companyId, email: fixture.adminEmail,
  } }, data: { roleId: role.id } });
  await prisma.bookingDraft.create({ data: { companyId: fixture.companyId, createdById: user.id, draftData } });
  return user;
}

async function wizard(page: Page) {
  const section = page.getByRole('button', { name: 'Post-Sales', exact: true });
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
  await page.getByRole('link', { name: 'New Booking', exact: true }).click();
  await page.getByRole('button', { name: /Resume/ }).click();
  await expect(page.getByLabel('Delay interest')).toBeVisible();
}

async function watchForLeaks(page: Page, forbidden: string) {
  await page.evaluate((text) => {
    const state = window as typeof window & { interestLeaks: string[] };
    state.interestLeaks = [];
    new MutationObserver(() => {
      if (document.body.textContent?.includes(text)) state.interestLeaks.push(text);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, forbidden);
}

async function noLeaks(page: Page) {
  expect(await page.evaluate(() => (window as typeof window & { interestLeaks: string[] }).interestLeaks)).toEqual([]);
}

for (const sameCompany of [false, true]) {
  test(`same-tab switch isolates ${sameCompany ? 'different users in one company' : 'different companies'} while the real lookup is pending`, async ({ page }) => {
    const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
    let release = () => {};
    try {
      const a = await seedE2eFixture(DATABASE_URL_SYSTEM);
      const userA = await accounts(prisma, a);
      let b: E2eFixture;
      if (sameCompany) {
        b = { ...a, adminEmail: `second-${a.adminEmail}` };
        const userB = await prisma.user.create({ data: {
          companyId: a.companyId, roleId: userA.roleId, name: 'Second Accounts', email: b.adminEmail,
          passwordHash: userA.passwordHash, forcePasswordChange: false,
        } });
        expect(userB.id).not.toBe(userA.id);
        await prisma.bookingDraft.create({ data: { companyId: a.companyId, createdById: userB.id, draftData } });
      } else {
        b = await seedE2eFixture(DATABASE_URL_SYSTEM);
        await accounts(prisma, b);
      }
      const aRule = await prisma.interestRule.create({ data: {
        companyId: a.companyId, name: `A private 17 ${a.companyId}`, ratePercent: 17, rateType: 'SIMPLE', frequency: 'YEARLY',
      } });
      await login(page, a);
      await wizard(page);
      await expect(page.getByLabel('Delay interest').locator('option', { hasText: aRule.name })).toHaveCount(1);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByLabel('Delay interest')).toHaveCount(0);
      if (sameCompany) await prisma.interestRule.update({ where: { id: aRule.id }, data: { isActive: false } });
      const bRule = await prisma.interestRule.create({ data: {
        companyId: b.companyId, name: `B current 23 ${b.companyId}`, ratePercent: 23, rateType: 'SIMPLE', frequency: 'YEARLY',
      } });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let requested = false;
      await page.route(lookup, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        requested = true;
        await gate;
        await route.fulfill({ response });
      });
      await watchForLeaks(page, aRule.name);
      await login(page, b, { navigate: false });
      await wizard(page);
      await expect(page.getByLabel('Delay interest').locator('option', { hasText: aRule.name })).toHaveCount(0);
      await expect.poll(() => requested).toBe(true);
      await noLeaks(page);
      release();
      await expect(page.getByLabel('Delay interest').locator('option', { hasText: bRule.name })).toHaveCount(1);
      await noLeaks(page);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await prisma.$disconnect();
    }
  });
}

test('a previous user response cannot populate the next session; forced session end hides the selector', async ({ page }) => {
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  let release = () => {};
  try {
    const a = await seedE2eFixture(DATABASE_URL_SYSTEM);
    const b = await seedE2eFixture(DATABASE_URL_SYSTEM);
    await accounts(prisma, a);
    const userB = await accounts(prisma, b);
    const aRule = await prisma.interestRule.create({ data: {
      companyId: a.companyId, name: `Late A 17 ${a.companyId}`, ratePercent: 17, rateType: 'SIMPLE', frequency: 'YEARLY',
    } });
    const bRule = await prisma.interestRule.create({ data: {
      companyId: b.companyId, name: `Current B 23 ${b.companyId}`, ratePercent: 23, rateType: 'SIMPLE', frequency: 'YEARLY',
    } });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captured = false;
    let delivered = false;
    await page.route(lookup, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (!captured) {
        captured = true;
        await gate;
        await route.fulfill({ response });
        delivered = true;
      } else await route.fulfill({ response });
    });
    await login(page, a);
    await wizard(page);
    await expect.poll(() => captured).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await watchForLeaks(page, aRule.name);
    await login(page, b, { navigate: false });
    await wizard(page);
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(page.getByLabel('Delay interest').locator('option', { hasText: bRule.name })).toHaveCount(1);
    await noLeaks(page);
    const adminRole = await prisma.role.findFirstOrThrow({ where: { companyId: b.companyId, slug: 'super_admin' } });
    const admin = await prisma.user.create({ data: {
      companyId: b.companyId, roleId: adminRole.id, name: 'Session test administrator',
      email: `control-${b.adminEmail}`, passwordHash: userB.passwordHash, forcePasswordChange: false,
    } });
    const control = await request.newContext({ baseURL: API_URL });
    try {
      const signedIn = await control.post('/api/v1/auth/login', { data: { email: admin.email, password: b.adminPassword } });
      expect(signedIn.status()).toBe(200);
      const csrf = (await control.storageState()).cookies.find((cookie) => cookie.name === 'openestate_csrf')!.value;
      const ended = await control.post(`/api/v1/users/${userB.id}/deactivate`, { headers: {
        Authorization: `Bearer ${(await signedIn.json()).accessToken}`, 'X-CSRF-Token': csrf,
      } });
      expect(ended.ok()).toBe(true);
    } finally {
      await control.dispose();
    }
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Delay interest')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Delay interest' })).toHaveCount(0);
    await noLeaks(page);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await prisma.$disconnect();
  }
});
