import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { API_URL } from '../playwright.config';

// v0.2.3: custom field VALUES, end to end through the real UI.
//
// Definitions have been definable since Phase 1, but nothing anywhere
// captured or displayed a VALUE — "defining a field has no effect
// elsewhere in the product" (CLAUDE.md, walkthrough issue #5). This
// scenario is the proof that the loop is closed: define a field in
// Admin → Custom Fields, capture a value on a real form, see it on the
// detail screen, and see it as a column in the CSV export.
//
// Also covers the two guardrails this release added, which are only
// really provable through the UI: BOOKING is refused as an entity type
// (its Add Field button is disabled), and a hard purge requires the
// field key typed back before it will run.

test('define a custom field → capture a value on a real form → see it on detail → see it in CSV', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const stamp = Date.now();
  const key = `e2e_source_note_${stamp}`;
  const label = `E2E Source Note ${stamp}`;
  const value = `captured-${stamp}`;

  await login(page, fixture);

  // ── Define an APPLICANT custom field ──
  await page.goto('/admin/custom-fields');
  await page.getByRole('button', { name: 'APPLICANT', exact: true }).click();
  await page.getByRole('button', { name: 'Add Field' }).click();
  await controlAfterLabel(page, 'Label').fill(label);
  await controlAfterLabel(page, 'Field Name').fill(key);
  const [defRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/custom-fields') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create Field' }).click(),
  ]);
  expect(defRes.ok()).toBe(true);
  await expect(page.getByText(label)).toBeVisible();

  // ── Capture a value through the real inquiry form ──
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'New inquiry' }).click();

  // The field must appear on the form with no code change — that is the
  // entire point of custom fields.
  const cfInput = controlAfterLabel(page, label);
  await expect(cfInput).toBeVisible();

  const applicantName = `E2E CF Applicant ${stamp}`;
  await controlAfterLabel(page, 'Applicant Name').fill(applicantName);
  await controlAfterLabel(page, 'Phone').fill(`9${String(stamp).slice(-9)}`);
  await cfInput.fill(value);

  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/inquiries') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create', exact: true }).click(),
  ]);
  expect(createRes.ok()).toBe(true);

  // ── See it on the detail screen ──
  await page.getByRole('link', { name: applicantName, exact: true }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries\/.+/);
  const display = page.getByTestId('inquiry-custom-field-display');
  await expect(display).toContainText(label);
  await expect(display).toContainText(value);

  // ── See it as a CSV column ──
  // Fetched against the API directly with its own login: the export has
  // no UI button, and page.request would resolve against the WEB
  // server's baseURL and carry no Bearer token (the access token lives
  // in the app's memory, not a cookie).
  const loginRes = await page.request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email: fixture.adminEmail, password: fixture.adminPassword },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { accessToken } = (await loginRes.json()) as { accessToken: string };

  const csv = await page.request.get(
    `${API_URL}/api/v1/reports/presales/inquiries-export?format=csv`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  expect(csv.ok()).toBe(true);
  const body = await csv.text();
  expect(body).toContain(`applicant.${label}`);
  expect(body).toContain(value);
});

test('BOOKING is marked unsupported and cannot have a field defined through the UI', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);
  await page.goto('/admin/custom-fields');

  await page.getByRole('button', { name: /^BOOKING/ }).click();
  await expect(page.getByText('Custom fields are not supported for BOOKING yet.')).toBeVisible();
  // Disabled rather than hidden: an admin who looks for it gets told
  // why, instead of silently not finding it.
  await expect(page.getByRole('button', { name: 'Add Field' })).toBeDisabled();
});

test('hard purge refuses to run until the field key is typed back', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const stamp = Date.now();
  const key = `e2e_purge_${stamp}`;
  const label = `E2E Purge Me ${stamp}`;

  await login(page, fixture);
  await page.goto('/admin/custom-fields');
  await page.getByRole('button', { name: 'PROJECT', exact: true }).click();
  await page.getByRole('button', { name: 'Add Field' }).click();
  await controlAfterLabel(page, 'Label').fill(label);
  await controlAfterLabel(page, 'Field Name').fill(key);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/custom-fields') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create Field' }).click(),
  ]);

  const row = page.getByRole('row', { name: new RegExp(label) });
  await row.getByRole('button', { name: 'Delete permanently' }).click();

  // Scoped by testid: the row's own trigger button shares the same
  // accessible name as the dialog's confirm button.
  const confirmBtn = page.getByTestId('purge-confirm');
  await expect(confirmBtn).toBeDisabled();

  // A near-miss must not unlock it — the confirmation is about the
  // specific thing being destroyed, not a formality.
  await page.getByPlaceholder(key).fill(`${key}x`);
  await expect(confirmBtn).toBeDisabled();

  await page.getByPlaceholder(key).fill(key);
  await expect(confirmBtn).toBeEnabled();

  const [purgeRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/purge') && r.request().method() === 'POST'),
    confirmBtn.click(),
  ]);
  expect(purgeRes.ok()).toBe(true);
  await expect(page.getByText(label)).toHaveCount(0);
});
