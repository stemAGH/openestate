import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel, openMasterTable } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// v0.9 item 1: delayed-payment interest, through the real UI.
//
// Book a unit and choose a delay-interest rule in the wizard (no default:
// nothing is preselected), then on the installment schedule accrue interest
// on an overdue installment. Interest runs only from the attach date, so on
// the day of attaching nothing is due; the spec then moves the attach date
// back 30 days in the database (the only way to let 30 days pass in a test)
// and accrues again through the UI, checking the amount against a hand
// calculation. Also: the Masters screen refuses a rate edit on a rule in use
// and shows why, and the rule can be removed from the schedule.
test('choose a rule when booking, accrue interest on an overdue installment, and the rule in use keeps its rate', async ({ page }) => {
  const fixture = readFixture('interestRule');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const ruleName = `E2E Delay 18% ${Date.now()}`;
  const priceRupees = '1000000'; // ₹10,00,000, one installment
  try {
    await prisma.interestRule.create({
      data: { companyId: fixture.companyId, name: ruleName, rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY' },
    });

    await login(page, fixture);

    // ── Book through the wizard ──
    await page.goto('/postsales/bookings/new');
    await page.getByRole('button', { name: '+ New applicant not found above' }).click();
    await page.getByPlaceholder('Full name').fill(`E2E Interest Applicant ${Date.now()}`);
    await page.getByPlaceholder('Phone', { exact: true }).fill(`9${Math.floor(100000000 + Math.random() * 900000000)}`);
    await page.getByRole('button', { name: 'Create & select' }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    const projectSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a project' }) });
    const unitSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select an available unit' }) });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
      projectSelect.selectOption({ index: 1 }),
    ]);
    await expect(unitSelect.locator('option')).toHaveCount(2);
    await unitSelect.selectOption({ index: 1 });
    await controlAfterLabel(page, 'Agreed base price (₹)').fill(priceRupees);
    await expect(controlAfterLabel(page, 'GST rate for base price')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click(); // no co-applicants

    await page.getByText('Custom schedule').click();
    await page.getByRole('button', { name: '+ Add installment' }).click();
    await page.getByPlaceholder('Label').fill('Full payment');
    await page.getByPlaceholder('Amount (₹)').fill(priceRupees);
    await page.getByRole('button', { name: 'Next' }).click();

    // Nothing preselected; booking without a choice is refused on screen.
    const interestChoice = page.getByLabel('Delay interest');
    await expect(interestChoice).toHaveValue('');
    await page.getByRole('button', { name: 'Confirm & Book' }).click();
    await expect(page.getByText('Choose a delay-interest rule, or "No delay interest", before booking.')).toBeVisible();

    await interestChoice.selectOption({ label: `${ruleName} (18% simple)` });
    const [putResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/interest-rule') && r.request().method() === 'PUT'),
      page.getByRole('button', { name: 'Confirm & Book' }).click(),
    ]);
    expect(putResponse.ok()).toBe(true);
    await page.waitForURL(/\/postsales\/bookings\/.+\/installments/);
    const bookingId = /bookings\/([^/]+)\/installments/.exec(page.url())![1];

    const today = new Date();
    const fmt = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'UTC' });
    const panel = page.getByRole('region', { name: 'Delay interest' });
    await expect(panel.getByTestId('interest-rule-current')).toHaveText(`${ruleName} (18% simple), from ${fmt(today)}`);

    // ── The installment fell due 60 days ago; nothing is due before the attach date ──
    const sixtyDaysAgo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 60));
    await prisma.installment.updateMany({ where: { bookingId }, data: { dueDate: sixtyDaysAgo } });
    await panel.getByRole('button', { name: 'Accrue interest now' }).click();
    await expect(panel.getByTestId('interest-message')).toHaveText('No interest is due as of today.');

    // ── Let 30 days pass since the rule was attached ──
    const thirtyDaysAgo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30));
    await prisma.booking.update({ where: { id: bookingId }, data: { interestFromDate: thirtyDaysAgo } });
    await page.reload();
    // ₹10,00,000 × 18% × 30 / 365 = ₹14,794.52 (half-up on paise)
    await panel.getByRole('button', { name: 'Accrue interest now' }).click();
    await expect(panel.getByTestId('interest-message')).toHaveText('Interest charged: ₹14,794.52.');
    const accruals = await prisma.interestAccrual.findMany({ where: { bookingId } });
    expect(accruals).toHaveLength(1);
    expect(accruals[0].accruedPaise).toBe(1_479_452n);

    // ── Masters: the rule in use keeps its rate, and the screen says why ──
    await openMasterTable(page, 'Interest Rules');
    await page.getByRole('row', { name: new RegExp(ruleName) }).getByRole('button', { name: 'Edit' }).click();
    await controlAfterLabel(page, 'Rate %').fill('24');
    const [patch] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/masters/interest-rules/') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Update' }).click(),
    ]);
    expect(patch.status()).toBe(409);
    await expect(page.getByText(/This interest rule is attached to 1 booking\(s\), so its rate can't be changed/)).toBeVisible();

    // ── Remove the rule from the schedule ──
    await page.goto(`/postsales/bookings/${bookingId}/installments`);
    await panel.getByLabel('Interest rule').selectOption({ label: 'No delay interest (remove)' });
    await panel.getByRole('button', { name: 'Apply' }).click();
    await expect(panel.getByTestId('interest-message')).toHaveText('Delay interest removed.');
    await expect(panel.getByTestId('interest-rule-current')).toHaveText('No delay interest.');
  } finally {
    await prisma.$disconnect();
  }
});
