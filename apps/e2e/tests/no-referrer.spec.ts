import { test, expect, type Page, type Request } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { PORTAL_URL } from '../playwright.config';

/**
 * Both apps keep things in their own address that must not leave the
 * browser: the staff Inquiries search (?q=<phone>) and the reset and invite
 * tokens (?token=…). A browser sends the page's address as the Referer of
 * every request, so it reached the API's and nginx's logs. Both apps now
 * set Referrer-Policy no-referrer; no API request may carry a Referer.
 */

const fixture = readFixture('mastersCrud');

/** Every /api/ request the page sends from now on (collected synchronously). */
function captureApi(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r: Request) => {
    if (r.url().includes('/api/')) seen.push(r);
  });
  return seen;
}

/** The captured requests with their Referer header, read once they've been sent. */
async function withReferer(requests: Request[]) {
  return Promise.all(requests.map(async (r) => ({ url: new URL(r.url()).pathname, referer: (await r.allHeaders())['referer'] })));
}

test('staff app: API requests from a page with a phone search in its address carry no Referer', async ({ page }) => {
  await login(page, fixture);
  const seen = captureApi(page);
  await page.goto('/presales/inquiries?q=%2B91+98765+43210');
  await expect(page.getByRole('heading', { name: 'Inquiries' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const sent = await withReferer(seen);
  // Control: the page did call the API, with the search applied.
  expect(sent.some((r) => r.url.endsWith('/api/v1/inquiries'))).toBe(true);
  expect(sent.filter((r) => r.referer !== undefined), 'API requests that carried a Referer').toEqual([]);
});

test('portal: the reset request from a page with a token in its address carries no Referer', async ({ page }) => {
  const seen = captureApi(page);
  // The portal's router has basename "/portal", in dev as in production.
  await page.goto(`${PORTAL_URL}/portal/reset-password?token=e2e-not-a-real-token-0123456789`);
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  await page.locator('#newPassword').fill('NotARealPassword#123');
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/password-reset/confirm')),
    page.getByRole('button', { name: 'Reset password' }).click(),
  ]);
  // Control: the request was sent (and refused: the token is made up).
  expect(res.ok()).toBe(false);
  const sent = await withReferer(seen);
  expect(sent.filter((r) => r.url.includes('/password-reset/confirm')).length).toBe(1);
  expect(sent.filter((r) => r.referer !== undefined), 'API requests that carried a Referer').toEqual([]);
});
