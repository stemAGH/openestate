import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { E2eFixture } from './seed';

/** Straight login for fixtures seeded with forcePasswordChange: false (the default). */
export async function login(page: Page, fixture: E2eFixture, options: { navigate?: boolean } = {}) {
  if (options.navigate !== false) await page.goto('/login');
  await page.locator('#email').fill(fixture.adminEmail);
  await page.locator('#password').fill(fixture.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Several forms across this app (Masters, ReceiptEntry, ...) pair a
 * <label> with its input/select/textarea by position only — no id/
 * htmlFor, so getByLabel can't find them. This locates the control
 * immediately following a label with the given exact text.
 */
export function controlAfterLabel(root: Page | Locator, label: string) {
  return root.locator(
    `xpath=//label[normalize-space(text())="${label}"]/following-sibling::*[self::input or self::select or self::textarea][1]`,
  );
}

/** Reads a Reports page Stat tile's value by its label (e.g. "Total collected"). */
export async function readStat(page: Page, label: string): Promise<string> {
  const value = page.locator(`xpath=//div[normalize-space(text())="${label}"]/following-sibling::div[1]`);
  return (await value.textContent()) ?? '';
}

/**
 * Navigates to Admin → Masters and opens a specific table's pill, given
 * only its label — never the category it lives in. Masters.tsx
 * (feat/categorise-masters-ui) groups the 22 master tables into
 * collapsible categories; a table's pill is only IN THE DOM once its
 * category is expanded (the category content is conditionally rendered,
 * not just CSS-hidden), and only the category containing the page's
 * initially-selected table auto-opens. A spec written against the old
 * flat layout that clicks a table pill straight after `page.goto` will
 * time out for any table outside that one auto-opened category.
 *
 * Deliberately does not hardcode which category holds which table —
 * that mapping lives in Masters.tsx and duplicating it here would mean
 * this helper (and every spec using it) goes stale the moment someone
 * re-groups a table, silently the same way the original bug did. Instead
 * it works the DOM directly: check whether the pill is already reachable
 * (covers a table in the auto-opened category, or one whose category a
 * prior step already expanded); if not, walk each category header in
 * order and expand only the ones that are still collapsed — checking
 * `aria-expanded` first, never clicking one already open — until the
 * pill appears.
 */
export async function openMasterTable(page: Page, tableLabel: string) {
  await page.goto('/admin/masters');

  // Category headers are the only `main` buttons carrying aria-expanded
  // (Masters.tsx sets it only on the category toggle) — this can't
  // collide with AppShell's own sidebar section toggles, which live
  // outside <main>.
  const categoryHeaders = page.locator('main button[aria-expanded]');
  // A fresh navigation's category buttons (and the target pill) don't
  // exist yet the instant goto() resolves — the page is still on its
  // "Loading…" state fetching the current user before it renders
  // Masters.tsx at all. `.isVisible()` doesn't wait, so checking the
  // pill immediately would race that and always report "not found."
  // Waiting for the first category header is a real precondition of
  // this page having rendered, regardless of which table is targeted.
  await categoryHeaders.first().waitFor({ state: 'visible' });

  const pill = page.getByRole('button', { name: tableLabel, exact: true });
  if (await pill.isVisible()) {
    await pill.click();
    return;
  }

  const count = await categoryHeaders.count();
  for (let i = 0; i < count; i++) {
    const header = categoryHeaders.nth(i);
    if ((await header.getAttribute('aria-expanded')) === 'true') continue;
    await header.click();
    if (await pill.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
      await pill.click();
      return;
    }
  }

  throw new Error(`openMasterTable: no category on /admin/masters contains a table pill named "${tableLabel}"`);
}
