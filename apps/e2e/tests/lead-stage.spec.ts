import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

// Real-browser coverage for Phase 0 of feature-completion-plan.md — the
// parts that can ONLY be proven by an actual rendered UI, not already
// covered by apps/api's own service-level/RLS/concurrency tests
// (see apps/api/test/lead-stage.test.ts for those): the admin Lead
// Stages page's default-flip and occupied-stage reassign-on-deactivate
// flow, and InquiryDetail's stage picker actually persisting a change.

test('Lead Stages admin: seeded pipeline, default flip, occupied-stage deactivate requires reassignment, and the InquiryDetail picker persists', async ({ page }) => {
  const fixture = readFixture('leadStage');
  await login(page, fixture);

  await page.goto('/admin/lead-stages');

  // Seeded default pipeline — six stages, "New" marked default. Targeted
  // by name, not table position — a same-sortOrder tie with a
  // later-created stage is a real, legitimate state (untested here) that
  // a position-based locator would misread as a product bug.
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(6);
  const seededNewRow = page.getByRole('row', { name: 'New' });
  await expect(seededNewRow).toBeVisible();
  await expect(seededNewRow.getByRole('cell').nth(2)).toHaveText('Yes'); // Default column

  // Create a 7th stage marked default → the seeded "New" must flip off.
  const stageName = `E2E Stage ${Date.now()}`;
  await page.getByRole('button', { name: 'Add Stage' }).click();
  await controlAfterLabel(page, 'Name').fill(stageName);
  await page.getByLabel('Default stage for new leads').check();
  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/lead-stages') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);

  const newStageRow = page.getByRole('row', { name: new RegExp(stageName) });
  await expect(newStageRow).toBeVisible();
  await expect(newStageRow.getByRole('cell').nth(2)).toHaveText('Yes'); // Default column
  await expect(seededNewRow.getByRole('cell').nth(2)).toHaveText('No'); // "New" flipped off

  // Occupy the new stage with a real inquiry, created through the real
  // Inquiries form (not seeded directly), then moved onto it through the
  // real InquiryDetail picker.
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'New inquiry' }).click();
  const applicantName = `E2E Lead ${Date.now()}`;
  await controlAfterLabel(page, 'Applicant Name').fill(applicantName);
  await controlAfterLabel(page, 'Phone').fill(`9${String(Date.now()).slice(-9)}`);
  const [inquiryCreateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(inquiryCreateResponse.ok()).toBe(true);

  await page.getByRole('link', { name: applicantName, exact: true }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries\/[0-9a-f-]{36}$/);
  const [stagePatchResponse] = await Promise.all([
    page.waitForResponse((r) => /\/inquiries\/[0-9a-f-]{36}$/.test(r.url()) && r.request().method() === 'PATCH'),
    controlAfterLabel(page, 'Stage').selectOption({ label: stageName }),
  ]);
  expect(stagePatchResponse.ok()).toBe(true);

  // A stage that's still the current default can't be deactivated (Phase 0
  // finding #1: refused outright, never auto-resolved) — make "New" the
  // default again first, the same explicit admin step the guard requires.
  await page.goto('/admin/lead-stages');
  await seededNewRow.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Default').check();
  const [defaultFlipResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/lead-stages/') && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect(defaultFlipResponse.ok()).toBe(true);
  await expect(seededNewRow.getByRole('cell').nth(2)).toHaveText('Yes'); // Default column
  await expect(newStageRow.getByRole('cell').nth(2)).toHaveText('No');

  // Deactivating the now-occupied stage must be blocked until a
  // reassignment target is given — not attempted-and-silently-failed.
  await newStageRow.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Active').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/1 active lead/)).toBeVisible();

  await page.getByLabel('Reassign to').selectOption({ label: 'New' });
  const [deactivateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/lead-stages/') && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Reassign and deactivate' }).click(),
  ]);
  expect(deactivateResponse.ok()).toBe(true);
  await expect(newStageRow.getByRole('cell').nth(3)).toHaveText('No'); // Active column

  // The reassignment must be reflected back on the inquiry itself, not
  // just on the stage's own occupancy count.
  await page.goto('/presales/inquiries');
  await page.getByRole('link', { name: applicantName, exact: true }).click();
  await expect(controlAfterLabel(page, 'Stage')).toHaveValue(await controlAfterLabel(page, 'Stage').locator('option', { hasText: 'New' }).getAttribute('value') as string);
});
