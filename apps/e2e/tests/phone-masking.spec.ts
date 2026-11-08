import { test, expect, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { seedOrgChart, type OrgChart } from '../fixtures/org-chart';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * Phone numbers in list views (CLAUDE.md): the sales lists show the last 4
 * digits, and neither the page nor any API response it receives during
 * load carries the full number. Call and WhatsApp fetch the number from the
 * inquiry's detail endpoint when pressed: Call follows a tel: link in the
 * same tab; WhatsApp opens a tab at once and points it at wa.me, or closes
 * it if the number is refused.
 */

const fixture = readFixture('mastersCrud');
let org: OrgChart;
const tag = `PM${Date.now()}`;
const name = `${tag} Rohan Mask`;
// Random, not from Date.now(): other specs' names carry timestamps, whose
// digits would match a time-derived number.
const digits = `97${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`; // 10-digit Indian mobile
const stored = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
const masked = `••••••${digits.slice(-4)}`;
let inquiryId = '';

test.beforeAll(async () => {
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    org = await seedOrgChart(prisma, fixture.companyId);
    const rep = await prisma.user.findFirstOrThrow({ where: { companyId: fixture.companyId, email: org.repEmail } });
    const applicant = await prisma.applicant.create({
      data: { companyId: fixture.companyId, name, primaryPhone: stored, primaryPhoneNormalized: digits },
    });
    // Overdue, so it is also on the rep's My Day.
    const inq = await prisma.inquiry.create({
      data: { companyId: fixture.companyId, applicantId: applicant.id, assignedToId: rep.id, status: 'OPEN', nextFollowupAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    inquiryId = inq.id;
  } finally {
    await prisma.$disconnect();
  }
});

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(org.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Every /api/ response body the page receives (as text), from now on. */
function captureApi(page: Page): string[] {
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return;
    try { bodies.push(`${r.url()} ${await r.text()}`); } catch { /* redirects, aborted */ }
  });
  return bodies;
}
/** The full number, in any formatting ("+91 97xxx xxxxx" or digits only). */
const hasFull = (text: string) => text.replace(/[\s-]/g, '').includes(digits);

for (const who of ['manager', 'executive'] as const) {
  test(`${who}: Inquiries and My Day show the last 4 digits; no full number in the DOM or API responses`, async ({ page }) => {
    const bodies = captureApi(page);
    await signIn(page, who === 'manager' ? org.managerEmail : org.repEmail);
    await page.goto(`/presales/inquiries?q=${tag}`);
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText(masked);
    await page.waitForLoadState('networkidle');
    expect(hasFull(await page.content()), 'full number in the Inquiries DOM').toBe(false);
    if (who === 'executive') {
      await page.goto('/');
      await expect(page.getByTestId('my-day')).toContainText(name);
      await page.waitForLoadState('networkidle');
      expect(hasFull(await page.content()), 'full number in the dashboard DOM').toBe(false);
    }
    const leaks = bodies.filter(hasFull).map((b) => b.split(' ')[0]);
    expect(leaks, 'API responses carrying the full number').toEqual([]);
  });
}

test('Call fetches the number on press and follows tel: in the same tab', async ({ page }) => {
  // Record tel: links instead of handing them to the OS.
  await page.addInitScript(() => {
    const w = window as unknown as { __followed: string[] };
    w.__followed = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.href.startsWith('tel:')) w.__followed.push(this.href);
      else original.call(this);
    };
  });
  await signIn(page, org.repEmail);
  await page.goto(`/presales/inquiries?q=${tag}`);
  const detail = page.waitForResponse((r) => r.url().endsWith(`/inquiries/${inquiryId}`) && r.request().method() === 'GET');
  await page.getByRole('button', { name: `Call ${name}` }).click();
  await detail;
  await expect.poll(() => page.evaluate(() => (window as unknown as { __followed: string[] }).__followed)).toEqual([`tel:+91${digits}`]);
  expect(page.context().pages()).toHaveLength(1); // no new tab
});

test('WhatsApp opens a tab at once and points it at wa.me with a single 91', async ({ page, context }) => {
  await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>wa</p>' }));
  await signIn(page, org.repEmail);
  await page.goto('/');
  const popup = context.waitForEvent('page');
  await page.getByTestId('my-day').getByRole('button', { name: `WhatsApp ${name}` }).click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toBe(`https://wa.me/91${digits}`);
  // The opened tab cannot reach back into the CRM tab.
  expect(await tab.evaluate(() => window.opener)).toBeNull();
});

test('WhatsApp closes the tab it opened when the number is refused', async ({ page, context }) => {
  await signIn(page, org.repEmail);
  await page.goto(`/presales/inquiries?q=${tag}`);
  await page.route(`**/api/v1/inquiries/${inquiryId}`, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }) }),
  );
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: `WhatsApp ${name}` }).click();
  const tab = await popup;
  if (!tab.isClosed()) await tab.waitForEvent('close');
  expect(tab.isClosed()).toBe(true);
  await expect(page.getByText(`Couldn't get ${name}'s number.`)).toBeVisible();
});
