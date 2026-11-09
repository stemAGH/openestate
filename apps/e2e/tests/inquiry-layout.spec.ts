import { test, expect, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { seedOrgChart, type OrgChart } from '../fixtures/org-chart';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * Wide-screen layout while a page scrolls (found in the v0.10.0 rehearsal):
 *  - a sticky "Log follow-up" card slid over the Reassign card below it;
 *  - the sidebar scrolled away with the page, and the sticky top bar sat
 *    over content (card headings) scrolling beneath it.
 * Each check scrolls the document from top to bottom in small steps.
 */

const fixture = readFixture('mastersCrud');
let org: OrgChart;
let inquiryId = '';
const name = `LAYOUT${Date.now()} Lead`;
const WIDTHS = [1024, 1440, 1920];
// Short enough that every checked page scrolls.
const HEIGHT = 600;

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

async function signInAsManager(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill(org.managerEmail);
  await page.locator('#password').fill(org.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

interface ScrollReport {
  maxScroll: number;
  steps: number;
  /** Scroll offsets where a card heading (h1/h2 in main) sat under the top bar. */
  headingsUnderBar: string[];
  /** Scroll offsets where the sidebar's first item was off-screen or covered. */
  firstItemHidden: number[];
  /** After scrolling to the bottom and scrolling only the sidebar's own nav: is its last item reachable? */
  lastItemReachable: boolean;
  documentMovedForSidebar: boolean;
}

/** Scrolls the document top to bottom and checks the shell at every step. */
async function scrollAndCheckShell(page: Page): Promise<ScrollReport> {
  return page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const header = document.querySelector('header')!;
    const nav = document.querySelector('aside nav') as HTMLElement;
    const links = Array.from(nav.querySelectorAll('a'));
    const first = links[0]!;
    const last = links[links.length - 1]!;
    const hits = (el: Element) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return false;
      const at = document.elementFromPoint(x, y);
      return !!at && (at === el || el.contains(at));
    };
    const maxScroll = document.scrollingElement!.scrollHeight - window.innerHeight;
    const headingsUnderBar: string[] = [];
    const firstItemHidden: number[] = [];
    let steps = 0;
    for (let y = 0; y <= maxScroll + 40; y += 40) {
      window.scrollTo(0, y);
      await frame();
      steps++;
      const bar = header.getBoundingClientRect();
      for (const h of Array.from(document.querySelectorAll('main h1, main h2'))) {
        const r = h.getBoundingClientRect();
        const under = r.bottom > bar.top && r.top < bar.bottom && r.right > bar.left && r.left < bar.right && r.height > 0;
        if (under) headingsUnderBar.push(`${window.scrollY}:${h.textContent?.trim()}`);
      }
      if (!hits(first)) firstItemHidden.push(window.scrollY);
    }
    window.scrollTo(0, maxScroll);
    await frame();
    const docY = window.scrollY;
    nav.scrollTop = nav.scrollHeight;
    await frame();
    const lastItemReachable = hits(last);
    return { maxScroll, steps, headingsUnderBar, firstItemHidden, lastItemReachable, documentMovedForSidebar: window.scrollY !== docY };
  });
}

function expectShellOk(report: ScrollReport) {
  // The page must scroll, or the checks prove nothing.
  expect(report.maxScroll, 'page scroll range').toBeGreaterThan(100);
  expect(report.steps).toBeGreaterThan(3);
  expect(report.headingsUnderBar, 'headings under the top bar (scrollY:heading)').toEqual([]);
  expect(report.firstItemHidden, 'scroll offsets where the first sidebar item was hidden').toEqual([]);
  expect(report.lastItemReachable, 'last sidebar item reachable by scrolling the sidebar alone').toBe(true);
  expect(report.documentMovedForSidebar).toBe(false);
}

for (const width of WIDTHS) {
  test(`${width} px: inquiry page, scrolled: Reassign usable, cards never overlap, shell intact`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await signInAsManager(page);
    await page.goto(`/presales/inquiries/${inquiryId}`);
    await expect(page.getByRole('heading', { name: 'Reassign' })).toBeVisible();

    // The two cards never overlap, at any scroll offset.
    const overlaps = await page.evaluate(async () => {
      const card = (title: string) =>
        Array.from(document.querySelectorAll('h2')).find((h) => h.textContent?.trim() === title)?.closest('.card') as HTMLElement;
      const log = card('Log follow-up');
      const reassign = card('Reassign');
      const max = document.scrollingElement!.scrollHeight - window.innerHeight;
      const out: number[] = [];
      for (let y = 0; y <= max + 40; y += 40) {
        window.scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const a = log.getBoundingClientRect();
        const b = reassign.getBoundingClientRect();
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(window.scrollY);
      }
      return out;
    });
    expect(overlaps, 'scroll offsets where Log follow-up and Reassign overlap').toEqual([]);

    // Scrolled to the bottom: the Reassign select and button are on top where they are drawn.
    const covered = await page.evaluate(async () => {
      window.scrollTo(0, document.scrollingElement!.scrollHeight);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const card = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent?.trim() === 'Reassign')!.closest('.card')!;
      const result: Record<string, boolean> = {};
      for (const [k, el] of [['select', card.querySelector('select')], ['button', Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Reassign')]] as const) {
        const r = el!.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        result[k] = !!at && (at === el || el!.contains(at));
      }
      return result;
    });
    expect(covered, 'Reassign controls hit by elementFromPoint at their centres').toEqual({ select: true, button: true });
    // And clickable (trial: nothing is reassigned).
    const assignTo = page.locator('#assign-to');
    await assignTo.selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Reassign' }).click({ trial: true });

    expectShellOk(await scrollAndCheckShell(page));
  });
}

// The same shell checks on the other key screens changed in PRs 1–2.
const SCREENS: Array<{ name: string; as: 'manager' | 'admin'; path: () => string }> = [
  { name: 'dashboard', as: 'manager', path: () => '/' },
  { name: 'inquiries', as: 'manager', path: () => '/presales/inquiries' },
  { name: 'users', as: 'admin', path: () => '/admin/users' },
  { name: 'masters', as: 'admin', path: () => '/admin/masters' },
  { name: 'cheque queue', as: 'admin', path: () => '/postsales/cheques' },
];

for (const width of WIDTHS) {
  test(`${width} px: shell stays intact while other key screens scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    let signedInAs: string | null = null;
    let checked = 0;
    for (const s of SCREENS) {
      if (signedInAs !== s.as) {
        if (signedInAs) {
          await page.getByRole('button', { name: 'Sign out' }).click();
          await expect(page).toHaveURL(/\/login$/);
        }
        if (s.as === 'manager') await signInAsManager(page);
        else await login(page, fixture);
        signedInAs = s.as;
      }
      await page.goto(s.path());
      await expect(page.locator('main h1').first()).toBeVisible();
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const report = await scrollAndCheckShell(page);
      if (report.maxScroll <= 100) continue; // fits the screen: nothing to scroll past
      await test.step(s.name, () => expectShellOk(report));
      checked++;
    }
    // At least one of these screens must actually scroll at this size.
    expect(checked, 'screens that scrolled and were checked').toBeGreaterThan(0);
  });
}
