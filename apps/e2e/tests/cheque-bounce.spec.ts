import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel, readStat } from '../fixtures/actions';

// Regression coverage for the REPORTS-phase financial-correctness bug
// (CLAUDE.md, "REPORTS phase — 1 serious financial-correctness bug found
// and fixed"): recordChequeEvent() reversed a bounced cheque's ledger
// entries correctly but never flipped is_reversed, so every collection
// report — including this one — kept counting bounced money as
// collected, indefinitely. The ledger was always right; only this flag
// was wrong, which is exactly why a report-level assertion is the right
// level for this test: it's what a real admin would look at and trust.
//
// Three checkpoints, not just before/after the bounce: reading the
// baseline before the receipt exists, and confirming the receipt was
// genuinely counted as collected before it bounced, rules out a
// vacuously-true assertion where the total just happened to be zero the
// whole time for an unrelated reason.

async function gotoReportsAndWait(page: Page) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/reports/postsales/collection/summary')),
    page.goto('/postsales/reports'),
  ]);
  return resp;
}

test('book a unit → record a cheque receipt → bounce it → Collection Summary ends up unchanged', async ({ page }) => {
  const fixture = readFixture('chequeBounce');
  const phone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
  const applicantName = `E2E Applicant ${Date.now()}`;
  const priceRupees = '1000000'; // ₹10,00,000 — the single installment, receipted and bounced in full

  await login(page, fixture);

  await gotoReportsAndWait(page);
  const baselineReceipts = await readStat(page, 'Total receipts');
  const baselineCollected = await readStat(page, 'Total collected');

  // ── Step 0: applicant ──
  await page.goto('/postsales/bookings/new');
  await page.getByRole('button', { name: '+ New applicant not found above' }).click();
  await page.getByPlaceholder('Full name').fill(applicantName);
  await page.getByPlaceholder('Phone', { exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Create & select' }).click();
  await page.getByRole('button', { name: 'Next' }).click(); // step 0 → 1

  // ── Step 1: unit — fixture seeds exactly one project and one unit.
  // Located by their placeholder option, not select order/index, since
  // neither select has a label to anchor to. ──
  const projectSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a project' }) });
  const unitSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select an available unit' }) });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
    projectSelect.selectOption({ index: 1 }),
  ]);
  // The network response resolving doesn't guarantee React has committed
  // the new <option> to the DOM yet — under CI's slower/shared runners
  // this genuinely raced and failed on a retry attempt (proven live: see
  // CLAUDE.md's apps/e2e entry). Wait for the real DOM state selectOption
  // needs (placeholder + the fixture's one seeded unit), not just the
  // network event.
  await expect(unitSelect.locator('option')).toHaveCount(2);
  await unitSelect.selectOption({ index: 1 });
  await controlAfterLabel(page, 'Agreed base price (₹)').fill(priceRupees);
  // The fixture seeds exactly one active GST rate, which BookingWizard
  // auto-preselects (never guessing when there's more than one option,
  // but nothing to guess when there's only one) — wait for that to land
  // before Next, since the button is disabled until a rate is selected.
  await expect(controlAfterLabel(page, 'GST rate for base price')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Next' }).click(); // step 1 → 2

  // ── Step 2: co-applicants (skip) ──
  await page.getByRole('button', { name: 'Next' }).click(); // step 2 → 3

  // ── Step 3: a single custom installment for the full price ──
  await page.getByText('Custom schedule').click();
  await page.getByRole('button', { name: '+ Add installment' }).click();
  await page.getByPlaceholder('Label').fill('Full payment');
  await page.getByPlaceholder('Amount (₹)').fill(priceRupees);
  await page.getByRole('button', { name: 'Next' }).click(); // step 3 → 4

  // ── Step 4: confirm (no broker) ──
  // v0.9: the wizard requires an explicit delay-interest choice.
  await page.getByLabel('Delay interest').selectOption('NONE');
  await page.getByRole('button', { name: 'Confirm & Book' }).click();
  await page.waitForURL(/\/postsales\/bookings\/.+\/installments/);

  // ── Record a cheque receipt for the full amount ──
  await page.goto('/postsales/receipts/new');
  await page.getByPlaceholder('98765xxxxx').fill(phone);
  await page.getByText(applicantName, { exact: false }).click(); // pick from search results

  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/plan-history')),
    controlAfterLabel(page, 'Booking').selectOption({ index: 1 }),
  ]);
  await controlAfterLabel(page, 'Mode').selectOption('CHEQUE');
  await controlAfterLabel(page, 'Instrument #').fill('CHQ-E2E-001');
  await controlAfterLabel(page, 'Gross amount received (₹)').fill(priceRupees);
  await page.getByRole('button', { name: 'Auto-fill oldest-dues-first' }).click();

  const [receiptResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/receipts') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Save & Print Receipt' }).click(),
  ]);
  expect(receiptResponse.ok()).toBe(true);

  // Confirm the receipt genuinely counted as collected before it bounces.
  await gotoReportsAndWait(page);
  expect(await readStat(page, 'Total receipts')).toBe(String(Number(baselineReceipts) + 1));
  const midCollected = await readStat(page, 'Total collected');
  expect(midCollected).not.toBe(baselineCollected);

  // ── Bounce the cheque ──
  await page.goto('/postsales/cheques');
  const chequeRow = page.getByRole('row', { name: /CHQ-E2E-001/ });
  await expect(chequeRow).toBeVisible();
  await chequeRow.getByRole('button', { name: 'Bounce' }).click();
  await page.getByPlaceholder('Reason (e.g. insufficient funds)').fill('E2E test bounce — insufficient funds');
  const [bounceResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/cheque-event') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Confirm bounce' }).click(),
  ]);
  expect(bounceResponse.ok()).toBe(true);

  // ── The regression check: back to exactly the pre-receipt baseline ──
  await gotoReportsAndWait(page);
  expect(await readStat(page, 'Total receipts')).toBe(baselineReceipts);
  expect(await readStat(page, 'Total collected')).toBe(baselineCollected);
});
