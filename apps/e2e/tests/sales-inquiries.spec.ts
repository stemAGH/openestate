import { test, expect, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { formatDate, istDayBounds } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { seedOrgChart, type OrgChart } from '../fixtures/org-chart';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * The sales screens as a sales manager and a sales executive see them:
 * no silent 403s, search and filters that the URL carries, follow-up
 * labels on the IST day, and named Call / WhatsApp links.
 *
 * Its own org chart (seedOrgChart) and its own tag-named leads, so other
 * specs' rows in the shared fixture company never match.
 */

const fixture = readFixture('mastersCrud');
let org: OrgChart;
const tag = `S${Date.now()}`;
const lead = { today: `${tag} Asha Today`, overdue: `${tag} Bala Overdue`, dumped: `${tag} Chitra Dumped` };
const phones = { today: `97${String(Date.now()).slice(-8)}` };
const noonIst = istDayBounds(new Date()).startOfToday.getTime() + 12 * 3_600_000;
const dueToday = new Date(noonIst);
const dueOverdue = new Date(noonIst - 2 * 86_400_000);

test.beforeAll(async () => {
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    org = await seedOrgChart(prisma, fixture.companyId);
    const rep = await prisma.user.findFirstOrThrow({ where: { companyId: fixture.companyId, email: org.repEmail } });
    let n = 0;
    const mk = async (name: string, status: 'OPEN' | 'CONTINUED' | 'DUMPED', nextFollowupAt: Date | null, phone?: string) => {
      const p = phone ?? `96${String(Date.now() + n++).slice(-8)}`;
      // Stored the way people type it ("+91 97… …"), so the links must normalise it.
      const stored = `+91 ${p.slice(0, 5)} ${p.slice(5)}`;
      const applicant = await prisma.applicant.create({
        data: { companyId: fixture.companyId, name, primaryPhone: stored, primaryPhoneNormalized: p },
      });
      await prisma.inquiry.create({
        data: { companyId: fixture.companyId, applicantId: applicant.id, assignedToId: rep.id, status, nextFollowupAt },
      });
    };
    await mk(lead.today, 'OPEN', dueToday, phones.today);
    await mk(lead.overdue, 'CONTINUED', dueOverdue);
    await mk(lead.dumped, 'DUMPED', null);
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

/** Every API response the page gets that is a 403. */
function watch403s(page: Page): string[] {
  const seen: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 403 && r.url().includes('/api/')) seen.push(new URL(r.url()).pathname);
  });
  return seen;
}

const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

for (const who of ['manager', 'executive'] as const) {
  test(`${who}: dashboard, inquiries and an inquiry page load without any 403`, async ({ page }) => {
    const forbidden = watch403s(page);
    await signIn(page, who === 'manager' ? org.managerEmail : org.repEmail);
    await page.waitForLoadState('networkidle');
    await page.goto('/presales/inquiries');
    await expect(row(page, lead.today)).toBeVisible();
    await page.getByRole('link', { name: lead.today, exact: true }).click();
    await expect(page.getByRole('heading', { name: lead.today })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(forbidden).toEqual([]);
    // Reassign needs presales.inquiry.assign: the manager has it, the executive doesn't.
    await expect(page.getByRole('button', { name: 'Reassign' })).toHaveCount(who === 'manager' ? 1 : 0);
  });
}

test('search and filters narrow the list and live in the URL', async ({ page }) => {
  await signIn(page, org.managerEmail);
  await page.goto('/presales/inquiries');

  await page.getByRole('searchbox', { name: /search inquiries/i }).fill(tag);
  await expect(page).toHaveURL(new RegExp(`q=${tag}`));
  await expect(row(page, tag)).toHaveCount(3);
  // The search narrows the list: the team's other leads (seedOrgChart's) are gone.
  await expect(page.getByRole('row').filter({ hasText: 'E2E OrgChart Applicant' })).toHaveCount(0);

  await page.getByLabel('Filter by follow-up').selectOption('today');
  await expect(page).toHaveURL(/followUp=today/);
  await expect(row(page, tag)).toHaveCount(1);
  await expect(row(page, lead.today)).toContainText('Today');
  await expect(row(page, lead.today)).toContainText(formatDate(dueToday));

  await page.getByLabel('Filter by follow-up').selectOption('overdue');
  await expect(row(page, tag)).toHaveCount(1);
  await expect(row(page, lead.overdue)).toContainText('2 days overdue');
  await expect(row(page, lead.overdue)).toContainText('Continued');

  await page.getByLabel('Filter by follow-up').selectOption('');
  await page.getByLabel('Filter by status').selectOption('DUMPED');
  await expect(row(page, tag)).toHaveCount(1);
  await expect(row(page, lead.dumped)).toContainText('Dumped');

  // The URL alone reproduces the view (a dashboard link or the back button).
  await page.reload();
  await expect(row(page, tag)).toHaveCount(1);
  await expect(row(page, lead.dumped)).toBeVisible();

  // The manager's owner filter offers their team; the rep owns all three.
  await page.getByLabel('Filter by status').selectOption('');
  await page.getByLabel('Filter by owner').selectOption({ label: org.repName });
  await expect(row(page, tag)).toHaveCount(3);
  await page.getByLabel('Filter by owner').selectOption({ label: 'Me' });
  await expect(row(page, tag)).toHaveCount(0);
  await expect(page.getByText('No inquiries match these filters')).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries$/);
});

test('each row has named Call and WhatsApp buttons (pressing them: phone-masking.spec.ts)', async ({ page }) => {
  await signIn(page, org.repEmail);
  await page.goto(`/presales/inquiries?q=${encodeURIComponent(lead.today)}`);
  const r = row(page, lead.today);
  await expect(r.getByRole('button', { name: `Call ${lead.today}` })).toBeVisible();
  await expect(r.getByRole('button', { name: `WhatsApp ${lead.today}` })).toBeVisible();
});

test('a dashboard tile opens the list filtered to what it counts', async ({ page }) => {
  await signIn(page, org.repEmail);
  await page.getByRole('link', { name: /Overdue follow-ups/ }).first().click();
  await expect(page).toHaveURL(/\/presales\/inquiries\?followUp=overdue/);
  await expect(row(page, lead.overdue)).toBeVisible();
  await expect(row(page, lead.today)).toHaveCount(0);
});

test('the inquiry page shows readable status actions and contact links', async ({ page }) => {
  await signIn(page, org.repEmail);
  await page.goto(`/presales/inquiries?q=${encodeURIComponent(lead.today)}`);
  await page.getByRole('link', { name: lead.today, exact: true }).click();
  await expect(page.getByTestId('inquiry-status')).toHaveText('Open');
  for (const label of ['Mark as Continued', 'Mark as Dumped', 'Mark as Successful']) {
    await expect(page.getByRole('button', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /Mark (OPEN|CONTINUED|DUMPED|SUCCESSFUL)/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Call ${lead.today}` })).toBeVisible();
  await expect(page.getByRole('link', { name: `WhatsApp ${lead.today}` })).toBeVisible();
});
