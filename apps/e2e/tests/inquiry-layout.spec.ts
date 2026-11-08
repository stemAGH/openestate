import { test, expect, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { seedOrgChart, type OrgChart } from '../fixtures/org-chart';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * The inquiry page's right-hand column holds the "Log follow-up" card and,
 * for people who can reassign, the "Reassign" card below it. A sticky
 * "Log follow-up" card once slid over the Reassign card as the page
 * scrolled (found in the v0.10.0 rehearsal). Scrolls the page from top to
 * bottom as a sales manager and checks the two cards never overlap.
 */

const fixture = readFixture('mastersCrud');
let org: OrgChart;
let inquiryId = '';
const name = `LAYOUT${Date.now()} Lead`;

test.beforeAll(async () => {
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    org = await seedOrgChart(prisma, fixture.companyId);
    const rep = await prisma.user.findFirstOrThrow({ where: { companyId: fixture.companyId, email: org.repEmail } });
    const phone = `95${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const applicant = await prisma.applicant.create({
      data: { companyId: fixture.companyId, name, primaryPhone: phone, primaryPhoneNormalized: phone },
    });
    inquiryId = (await prisma.inquiry.create({
      data: { companyId: fixture.companyId, applicantId: applicant.id, assignedToId: rep.id, status: 'OPEN' },
    })).id;
  } finally {
    await prisma.$disconnect();
  }
});

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill(org.managerEmail);
  await page.locator('#password').fill(org.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

for (const width of [1024, 1440]) {
  test(`${width} px: Log follow-up and Reassign never overlap while the page scrolls`, async ({ page }) => {
    // Short enough that the page scrolls past the right-hand column.
    await page.setViewportSize({ width, height: 600 });
    await signIn(page);
    await page.goto(`/presales/inquiries/${inquiryId}`);
    await expect(page.getByRole('heading', { name: 'Reassign' })).toBeVisible();

    const result = await page.evaluate(async () => {
      const card = (title: string) =>
        Array.from(document.querySelectorAll('h2')).find((h) => h.textContent?.trim() === title)?.closest('.card') as HTMLElement | null;
      const log = card('Log follow-up');
      const reassign = card('Reassign');
      if (!log || !reassign) return { error: 'cards not found', overlaps: [] as number[], steps: 0, maxScroll: 0 };
      const scroller = document.querySelector('main')!.closest('.overflow-y-auto') ?? document.scrollingElement!;
      const maxScroll = Math.max(document.scrollingElement!.scrollHeight - window.innerHeight, (scroller as HTMLElement).scrollHeight - (scroller as HTMLElement).clientHeight);
      const overlaps: number[] = [];
      let steps = 0;
      for (let y = 0; y <= maxScroll + 40; y += 40) {
        window.scrollTo(0, y);
        (scroller as HTMLElement).scrollTop = y;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const a = log.getBoundingClientRect();
        const b = reassign.getBoundingClientRect();
        const intersect = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (intersect) overlaps.push(y);
        steps++;
      }
      return { error: null, overlaps, steps, maxScroll };
    });

    expect(result.error).toBeNull();
    // The page must actually scroll, or the check proves nothing.
    expect(result.maxScroll, 'page scroll range').toBeGreaterThan(200);
    expect(result.steps).toBeGreaterThan(5);
    expect(result.overlaps, 'scroll offsets where the cards overlap').toEqual([]);
  });
}
