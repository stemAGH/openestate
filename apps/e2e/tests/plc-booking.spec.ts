import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// v0.2.0 (PLC & unit-charge management): assign a PLC and a GST-rated
// charge to a unit through the real Pricing UI (ProjectDetail.tsx), book
// it, and confirm both the confirm step's excl.-GST breakup AND the
// final agreedPricePaise (which DOES include GST) match hand-computed
// expectations — proving the charge type's OWN gstRateId is what taxed
// it, not a coincidence.
//
// The base line's rate is explicitly picked as the fixture's 0% default
// (a real, deliberate choice through the real picker — not the old
// "no picker exists" gap), so the base line and the PLC line (which has
// no chargeType to carry a rate at all) are untaxed — only the charge
// line is, at its charge type's own 5%. That asymmetry is deliberate:
// it's the clearest possible proof that GST resolution is genuinely
// per-line, not inherited from a blanket booking-level setting.
test('assign a PLC and a GST-rated charge to a unit, book it, and confirm the total is right', async ({ page }) => {
  const fixture = readFixture('plcBooking');
  const baseRupees = 5_000_000; // ₹50,00,000
  const plcPercent = 2;
  const plcRupees = (baseRupees * plcPercent) / 100; // ₹1,00,000
  const chargeRupees = 50_000;
  const chargeGstRupees = (chargeRupees * fixture.chargeTypeGstRatePercent!) / 100; // ₹2,500 at 5%
  const expectedTotalRupees = baseRupees + plcRupees + chargeRupees + chargeGstRupees; // ₹51,52,500

  await login(page, fixture);

  // ── Assign the PLC and charge through the real Pricing UI ──
  await page.goto('/inventory/projects');
  await page.getByRole('link', { name: fixture.projectName }).click();

  const unitRow = page.getByRole('row', { name: new RegExp(fixture.unitNumber) });
  await unitRow.getByRole('button', { name: 'Pricing' }).click();

  await page.locator('select').filter({ has: page.locator('option', { hasText: fixture.plcTypeName! }) }).selectOption({ label: fixture.plcTypeName! });
  await controlAfterLabel(page, 'Percentage of base rate').fill(String(plcPercent));
  const [plcResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/plcs') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Add PLC' }).click(),
  ]);
  expect(plcResponse.ok()).toBe(true);
  await expect(page.getByText(new RegExp(`${fixture.plcTypeName}.*₹1,00,000`))).toBeVisible();

  await page.locator('select').filter({ has: page.locator('option', { hasText: fixture.chargeTypeName! }) }).selectOption({ label: fixture.chargeTypeName! });
  await controlAfterLabel(page, 'Amount (₹)').fill(String(chargeRupees));
  const [chargeResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/charges') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Add Charge' }).click(),
  ]);
  expect(chargeResponse.ok()).toBe(true);
  await expect(page.getByText(new RegExp(`${fixture.chargeTypeName}.*₹50,000`))).toBeVisible();

  // ── Book the unit ──
  const applicantName = `E2E PLC Applicant ${Date.now()}`;
  const phone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;

  await page.goto('/postsales/bookings/new');
  await page.getByRole('button', { name: '+ New applicant not found above' }).click();
  await page.getByPlaceholder('Full name').fill(applicantName);
  await page.getByPlaceholder('Phone', { exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Create & select' }).click();
  await page.getByRole('button', { name: 'Next' }).click(); // step 0 → 1

  const projectSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a project' }) });
  const unitSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select an available unit' }) });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
    projectSelect.selectOption({ index: 1 }),
  ]);
  await expect(unitSelect.locator('option')).toHaveCount(2);
  // Wait for the unit's PLC/charge lookups the wizard fires once a unit
  // is selected, so step 4's breakup is populated by the time we get there.
  const [, plcsResp, chargesResp] = await Promise.all([
    unitSelect.selectOption({ index: 1 }),
    page.waitForResponse((r) => r.url().includes('/plcs') && r.request().method() === 'GET'),
    page.waitForResponse((r) => r.url().includes('/charges') && r.request().method() === 'GET'),
  ]);
  expect(plcsResp.ok()).toBe(true);
  expect(chargesResp.ok()).toBe(true);
  await controlAfterLabel(page, 'Agreed base price (₹)').fill(String(baseRupees));
  // withPricingMasters seeds TWO active GST rates (the always-on 0%
  // default plus this fixture's own 5% one for the charge type), so the
  // wizard's "only one option ⇒ auto-preselect" never fires here — pick
  // the 0% one explicitly, through the real select, same as a real admin
  // choosing not to tax the base price.
  await controlAfterLabel(page, 'GST rate for base price').selectOption({ label: fixture.defaultGstRateLabel });
  await page.getByRole('button', { name: 'Next' }).click(); // step 1 → 2

  await page.getByRole('button', { name: 'Next' }).click(); // step 2 → 3

  // Custom plan, one installment for the full agreed price. The wizard
  // has no way to preview the GST-inclusive total before this step, so
  // this test computes it the same way a GST-aware admin would have to:
  // by hand, from the same rate the charge type carries.
  await page.getByText('Custom schedule').click();
  await page.getByRole('button', { name: '+ Add installment' }).click();
  await page.getByPlaceholder('Label').fill('Full payment');
  await page.getByPlaceholder('Amount (₹)').fill(String(expectedTotalRupees));
  await page.getByRole('button', { name: 'Next' }).click(); // step 3 → 4

  // ── Confirm step: the excl.-GST breakup ──
  const rupeesText = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  await expect(page.getByText(`Base price`)).toBeVisible();
  const confirmDl = page.locator('dl');
  await expect(confirmDl).toContainText(rupeesText(baseRupees));
  await expect(confirmDl).toContainText(fixture.plcTypeName!);
  await expect(confirmDl).toContainText(rupeesText(plcRupees));
  await expect(confirmDl).toContainText(fixture.chargeTypeName!);
  await expect(confirmDl).toContainText(rupeesText(chargeRupees));
  await expect(confirmDl).toContainText('Total (excl. GST)');
  await expect(confirmDl).toContainText(rupeesText(baseRupees + plcRupees + chargeRupees));

  // v0.9: the wizard requires an explicit delay-interest choice.
  await page.getByLabel('Delay interest').selectOption('NONE');
  const [bookingResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/bookings') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Confirm & Book' }).click(),
  ]);
  expect(bookingResponse.ok()).toBe(true);
  const booking = (await bookingResponse.json()) as { id: string };
  await page.waitForURL(/\/postsales\/bookings\/.+\/installments/);

  // ── The regression check: agreedPricePaise really does include GST,
  // computed per-line off the charge type's own rate ──
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const saved = await prisma.booking.findFirst({ where: { id: booking.id } });
    expect(saved!.agreedPricePaise.toString()).toBe(String(BigInt(expectedTotalRupees) * 100n));

    const lines = await prisma.bookingCostLine.findMany({ where: { bookingId: booking.id }, orderBy: { sortOrder: 'asc' } });
    const chargeLine = lines.find((l: { kind: string }) => l.kind === 'OTHER')!;
    expect(chargeLine.gstRatePercentSnapshot.toString()).toBe(String(fixture.chargeTypeGstRatePercent));
    expect(chargeLine.cgstPaise + chargeLine.sgstPaise + chargeLine.igstPaise).toBe(BigInt(chargeGstRupees) * 100n);

    const baseLine = lines.find((l: { kind: string }) => l.kind === 'BASE')!;
    const plcLine = lines.find((l: { kind: string }) => l.kind === 'PLC')!;
    expect(baseLine.gstRatePercentSnapshot.toString()).toBe('0'); // the fixture's 0% rate, picked explicitly
    expect(plcLine.gstRatePercentSnapshot.toString()).toBe('0'); // inherits the (untaxed) base line's rate
  } finally {
    await prisma.$disconnect();
  }
});
