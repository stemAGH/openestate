import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

// Regression coverage for a "check before building" item: FollowUp.
// createdById has been captured on every follow-up since Phase 3, and
// FollowUpService.findAllForInquiry already fetched it (`include:
// { createdBy: true }`) — but InquiryDetail.tsx never read it, so who
// logged a follow-up was invisible in the UI despite the data already
// being on the wire. Wiring the display up also surfaced a real,
// separate leak: that bare `createdBy: true` (and, in inquiry.service.ts,
// `assignedTo: true`) returned every scalar column on User —
// passwordHash/totpSecret included — over the wire; both are now scoped
// selects (covered by a backend test, e2e-inquiry-assignment.test.ts).

// Follow-Up Page spec gap #1 (internal plan followup-spec-gap-analysis.md):
// nextActionAt is now required while a lead is active (SOP rule 2) — a
// follow-up with no next-action date used to save silently; it now 400s.
// Reusing this exact flow (rather than adding a new spec/login) for that
// verification too: setting the next-action date to yesterday proves
// both halves of the same requirement — the lead lands in the My Day
// queue, and shows there as overdue, not just "saved".
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test('logging a follow-up shows who logged it, requires a next follow-up time, and the lead shows up overdue in My Day', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const applicantName = `E2E Attribution Applicant ${Date.now()}`;

  await login(page, fixture);
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'Add Inquiry' }).click();
  await controlAfterLabel(page, 'Applicant Name').fill(applicantName);
  await controlAfterLabel(page, 'Phone').fill('9812322222');
  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);

  await page.getByRole('link', { name: applicantName }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries\/.+/);

  // Saving with no next-action date on this still-active (OPEN) lead must
  // be refused — the exact bug this whole item exists to close.
  await page.locator('textarea').first().fill('Called, forgot to set a next date');
  const [rejected] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/follow-ups') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Log Follow-up' }).click(),
  ]);
  expect(rejected.ok()).toBe(false);
  await expect(page.getByText(/next follow-up time is required/i)).toBeVisible();

  const yesterday = new Date(Date.now() - 86_400_000);
  await controlAfterLabel(page, 'Next follow-up').fill(toDatetimeLocalValue(yesterday));
  await page.locator('textarea').first().fill('Called, interested, will visit site next week');
  const [followUpResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/follow-ups') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Log Follow-up' }).click(),
  ]);
  expect(followUpResponse.ok()).toBe(true);

  await expect(page.getByText('by E2E Admin')).toBeVisible();

  // My Day (GET /inquiries/my-day) had no frontend caller before this
  // fix — this is the first real-browser proof anything ever renders it.
  // Scoped to this test's own row, not the whole section — the fixture
  // company is shared across spec files, so other overdue rows may
  // legitimately be present too.
  await page.goto('/');
  const myDayRow = page.getByTestId('my-day').locator('li').filter({ hasText: applicantName });
  await expect(myDayRow).toBeVisible();
  await expect(myDayRow.getByText('Overdue')).toBeVisible();
});
