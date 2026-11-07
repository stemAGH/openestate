import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel, openMasterTable } from '../fixtures/actions';

// Follow-Up Page spec gap #2 (internal plan followup-spec-gap-analysis.md,
// SOP rule 5): Dump used to be a single-click status button with no
// reason or remarks captured at all. Real-browser coverage for the
// parts that can only be proven by an actual rendered UI, not already
// covered by apps/api's own service-level tests (see
// apps/api/test/inquiry-disposition.test.ts for those): the Dump Reasons
// master appearing in the admin Masters page at all (a real, separate
// gap found while wiring this up — the backend master existed but the
// frontend's hand-maintained MASTER_TABLES list didn't know about it),
// and the InquiryDetail Dump form actually requiring both fields before
// Confirm is even clickable.

test('Dump Reasons master is manageable from Admin → Masters, and dumping a lead requires both a reason and remarks', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const reasonName = `E2E Budget Mismatch ${Date.now()}`;

  await login(page, fixture);

  // The master itself — this is the gap that would have shipped silently:
  // the backend route worked, but nothing on this page's own type list
  // knew "dump-reasons" existed.
  // Dump Reasons happens to live in the category that auto-opens on load
  // (feat/categorise-masters-ui), so a direct click here passed only by
  // coincidence of where that table was placed in the grouping —
  // openMasterTable removes the dependency on that coincidence.
  await openMasterTable(page, 'Dump Reasons');
  await page.getByRole('button', { name: 'Add Item' }).click();
  await controlAfterLabel(page, 'Name').fill(reasonName);
  const [createReasonResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/dump-reasons') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(createReasonResponse.ok()).toBe(true);
  await expect(page.getByRole('row', { name: new RegExp(reasonName) })).toBeVisible();

  // A real lead to dump.
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'Add Inquiry' }).click();
  const applicantName = `E2E Dump Applicant ${Date.now()}`;
  await controlAfterLabel(page, 'Applicant Name').fill(applicantName);
  await controlAfterLabel(page, 'Phone').fill(`9${String(Date.now()).slice(-9)}`);
  const [inquiryCreateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(inquiryCreateResponse.ok()).toBe(true);
  await page.getByRole('link', { name: applicantName }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries\/[0-9a-f-]{36}$/);

  // Mark DUMPED opens the reason+remarks form rather than dumping
  // instantly — the whole point of this fix.
  await page.getByRole('button', { name: 'Mark DUMPED' }).click();
  const dumpForm = page.getByTestId('dump-form');
  const confirmButton = dumpForm.getByRole('button', { name: 'Confirm Dump' });
  await expect(confirmButton).toBeDisabled();

  await controlAfterLabel(dumpForm, 'Reason').selectOption({ label: reasonName });
  await expect(confirmButton).toBeDisabled(); // remarks still empty
  await controlAfterLabel(dumpForm, 'Remarks').fill('Went with a different builder');
  await expect(confirmButton).toBeEnabled();

  const [dumpResponse] = await Promise.all([
    page.waitForResponse((r) => /\/inquiries\/[0-9a-f-]{36}$/.test(r.url()) && r.request().method() === 'PATCH'),
    confirmButton.click(),
  ]);
  expect(dumpResponse.ok()).toBe(true);
  await expect(page.getByText('Status: DUMPED')).toBeVisible();
});
