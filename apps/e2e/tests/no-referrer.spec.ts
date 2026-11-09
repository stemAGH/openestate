import { test, expect, type Page, type Request } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { PORTAL_URL } from '../playwright.config';

/**
 * The web apps no longer send page addresses to the server: a page's own
 * address (the staff Inquiries search, ?q=<phone>, for example) used to go
 * out as the Referer of every API request and reach the server's logs. Both
 * apps set Referrer-Policy no-referrer; no API request may carry a Referer.
 */

const fixture = readFixture('mastersCrud');

/**
 * Every /api/ request the page completes from now on. Only completed ones:
 * a request cancelled by a navigation never reports its final headers.
 */
function captureApi(page: Page): Array<Promise<{ url: string; referer: string | undefined }>> {
  const seen: Array<Promise<{ url: string; referer: string | undefined }>> = [];
  page.on('requestfinished', (r: Request) => {
    if (r.url().includes('/api/')) {
      seen.push(r.allHeaders().then((h) => ({ url: new URL(r.url()).pathname, referer: h['referer'] })));
    }
  });
  return seen;
}

test('staff app: API requests from a page with a phone search in its address carry no Referer', async ({ page }) => {
  await login(page, fixture);
  // Let the dashboard's own requests finish before collecting.
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const seen = captureApi(page);
  await page.goto('/presales/inquiries?q=%2B91+98765+43210');
  await expect(page.getByRole('heading', { name: 'Inquiries' })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const sent = await Promise.all(seen);
  // Control: the page did call the API.
  expect(sent.some((r) => r.url.endsWith('/api/v1/inquiries'))).toBe(true);
  expect(sent.filter((r) => r.referer !== undefined), 'API requests that carried a Referer').toEqual([]);
});

test('portal: API requests from a page with a parameter in its address carry no Referer', async ({ page }) => {
  const seen = captureApi(page);
  // The portal's router has basename "/portal", in dev as in production. On
  // load the portal checks for a session (a refresh request to the API).
  await page.goto(`${PORTAL_URL}/portal/login?ref=e2e-sample-0123456789`);
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const sent = await Promise.all(seen);
  // Control: the portal did call the API from that page.
  expect(sent.length, 'API requests from the portal page').toBeGreaterThan(0);
  expect(sent.filter((r) => r.referer !== undefined), 'API requests that carried a Referer').toEqual([]);
});
