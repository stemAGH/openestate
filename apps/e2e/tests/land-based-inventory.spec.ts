import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// plotted-farmhouse-inventory.md Phase C, standard bar: a full LAND_BASED
// journey through the real UI — create project (shape picker) → group →
// two plots priced in DIFFERENT area units (acre and gunta, so a
// per-sqft-normalisation regression would show up as a wrong total) →
// book one → confirm the wizard's cost breakup, and separately confirm
// the DB's canonical landAreaSqft matches the conversion for both plots.
// Reuses 'mastersCrud' for login + the company's existing GST rate/area
// location (both company-wide masters, not project-scoped) — everything
// LAND_BASED-specific is created fresh through the browser.

test('create a LAND_BASED project, group, plots in acre and gunta, book one, and confirm the breakup + canonical sqft', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const tag = Date.now();
  const projectName = `E2E Land Project ${tag}`;
  const projectCode = `ELAND-${tag}`;
  const groupName = `Sector A ${tag}`;
  const plotAcreNumber = `PLOT-ACRE-${tag}`;
  const plotGuntaNumber = `PLOT-GUNTA-${tag}`;

  await login(page, fixture);

  // ── Create a LAND_BASED project through the real wizard ──
  await page.goto('/inventory/projects');
  await page.getByRole('button', { name: 'Add Project' }).click();
  await controlAfterLabel(page, 'Name').fill(projectName);
  await controlAfterLabel(page, 'Code').fill(projectCode);
  await controlAfterLabel(page, 'Inventory Shape').selectOption({ value: 'LAND_BASED' });
  await controlAfterLabel(page, 'Default Land Area Unit').selectOption({ value: 'ACRE' });
  // Area/Location drives GST place-of-supply — required or booking
  // fail-loud rejects (isIntraStateSupply never silently defaults). The
  // 'mastersCrud' fixture's company has exactly one, from its own
  // project's setup; area locations are company-wide, not project-scoped.
  await controlAfterLabel(page, 'Area/Location').selectOption({ index: 1 });
  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/projects') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);

  await expect(page.getByRole('row', { name: new RegExp(projectName) })).toContainText('Land-based');
  await page.getByRole('link', { name: projectName }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

  // Shape-conditional inventory tab: Inventory Groups, not Towers.
  await expect(page.getByRole('heading', { name: 'Inventory Groups' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Towers' })).not.toBeVisible();

  // ── Add a group ──
  await page.getByRole('button', { name: 'Add Group' }).click();
  await controlAfterLabel(page, 'Name').fill(groupName);
  await controlAfterLabel(page, 'Code').fill(`SECA-${tag}`);
  const [groupResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/inventory-groups') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(groupResponse.ok()).toBe(true);
  // The group's name also appears as an <option> in the Plots section's
  // "Filter by Group" select, which renders on the same page — scope to
  // the group-list pill (a <span>, not a <select>'s <option>) to avoid a
  // strict-mode ambiguity between the two.
  await expect(page.locator('span').filter({ hasText: groupName })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Plots' })).toBeVisible();

  // ── Plot 1: priced in ACRE, in the group ──
  await page.getByRole('button', { name: 'Add Plot' }).click();
  await controlAfterLabel(page, 'Plot Number').fill(plotAcreNumber);
  await controlAfterLabel(page, 'Group (optional)').selectOption({ label: groupName });
  await controlAfterLabel(page, 'Land Area Entered').fill('0.372');
  await controlAfterLabel(page, 'Land Area Unit').selectOption({ value: 'ACRE' });
  await controlAfterLabel(page, 'Rate Unit').selectOption({ value: 'ACRE' });
  await controlAfterLabel(page, 'Base Rate (₹ per Rate Unit)').fill('5000000'); // ₹50,00,000/acre
  const [plot1Response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units/land-based') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(plot1Response.ok()).toBe(true);
  const plot1 = (await plot1Response.json()) as { id: string };

  // ── Plot 2: priced in GUNTA, ungrouped ──
  await page.getByRole('button', { name: 'Add Plot' }).click();
  await controlAfterLabel(page, 'Plot Number').fill(plotGuntaNumber);
  await controlAfterLabel(page, 'Land Area Entered').fill('10');
  await controlAfterLabel(page, 'Land Area Unit').selectOption({ value: 'GUNTA' });
  await controlAfterLabel(page, 'Rate Unit').selectOption({ value: 'GUNTA' });
  await controlAfterLabel(page, 'Base Rate (₹ per Rate Unit)').fill('100000'); // ₹1,00,000/gunta
  const [plot2Response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units/land-based') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(plot2Response.ok()).toBe(true);
  const plot2 = (await plot2Response.json()) as { id: string };

  await expect(page.getByRole('row', { name: new RegExp(plotAcreNumber) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(plotGuntaNumber) })).toBeVisible();

  // Group filter narrows to the grouped plot only.
  await controlAfterLabel(page, 'Filter by Group').selectOption({ label: groupName });
  await expect(page.getByRole('row', { name: new RegExp(plotAcreNumber) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(plotGuntaNumber) })).not.toBeVisible();
  await controlAfterLabel(page, 'Filter by Group').selectOption({ label: 'All plots' });

  // ── DB check: canonical sqft matches the conversion for both units,
  // independently of what the wizard later does with them ──
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const dbPlot1 = await prisma.unit.findFirstOrThrow({ where: { id: plot1.id } });
    expect(Number(dbPlot1.landAreaSqft)).toBeCloseTo(16204.32, 1); // 0.372 acre × 43,560 sqft/acre
    const dbPlot2 = await prisma.unit.findFirstOrThrow({ where: { id: plot2.id } });
    expect(Number(dbPlot2.landAreaSqft)).toBeCloseTo(10890, 1); // 10 gunta × 1,089 sqft/gunta
  } finally {
    await prisma.$disconnect();
  }

  // ── Book the ACRE plot via the wizard's shape-conditional unit step ──
  const applicantName = `E2E Land Applicant ${tag}`;
  const phone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;

  await page.goto('/postsales/bookings/new');
  await page.getByRole('button', { name: '+ New applicant not found above' }).click();
  await page.getByPlaceholder('Full name').fill(applicantName);
  await page.getByPlaceholder('Phone', { exact: true }).fill(phone);
  await page.getByRole('button', { name: 'Create & select' }).click();
  await page.getByRole('button', { name: 'Next' }).click(); // step 0 → 1

  const projectSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a project' }) });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
    page.waitForResponse((r) => r.url().includes('/inventory-groups')),
    projectSelect.selectOption({ label: `${projectName} (${projectCode})` }),
  ]);

  // LAND_BASED-only group filter appears once a LAND_BASED project is
  // selected — narrow to the group, leaving exactly the acre plot.
  const groupFilterSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'All groups' }) });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
    groupFilterSelect.selectOption({ label: groupName }),
  ]);

  const unitSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select an available unit' }) });
  await expect(unitSelect.locator('option')).toHaveCount(2); // placeholder + the one grouped plot
  await unitSelect.selectOption({ index: 1 });

  // ₹50,00,000/acre × 0.372 acre = ₹18,60,000 — pre-filled client-side via
  // computeBaseAmountPaise, NOT the raw per-acre rate (the bug this fix
  // closes: baseRatePaise alone would have shown ₹50,00,000).
  const basePriceInput = controlAfterLabel(page, 'Agreed base price (₹)');
  await expect(basePriceInput).toHaveValue('1860000');

  await controlAfterLabel(page, 'GST rate for base price').selectOption({ label: fixture.defaultGstRateLabel });
  await page.getByRole('button', { name: 'Next' }).click(); // step 1 → 2
  await page.getByRole('button', { name: 'Next' }).click(); // step 2 → 3

  await page.getByText('Custom schedule').click();
  await page.getByRole('button', { name: '+ Add installment' }).click();
  await page.getByPlaceholder('Label').fill('Full payment');
  await page.getByPlaceholder('Amount (₹)').fill('1860000');
  await page.getByRole('button', { name: 'Next' }).click(); // step 3 → 4

  // ── Confirm step: the cost breakup shows the derived total, not the rate ──
  const confirmDl = page.locator('dl');
  await expect(confirmDl).toContainText('₹18,60,000');
  await expect(confirmDl).not.toContainText('₹50,00,000');

  // v0.9: the wizard requires an explicit delay-interest choice.
  await page.getByLabel('Delay interest').selectOption('NONE');
  const [bookingResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/bookings') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Confirm & Book' }).click(),
  ]);
  expect(bookingResponse.ok()).toBe(true);
  const booking = (await bookingResponse.json()) as { id: string };
  await page.waitForURL(/\/postsales\/bookings\/.+\/installments/);

  const verifyPrisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const saved = await verifyPrisma.booking.findFirstOrThrow({ where: { id: booking.id } });
    expect(saved.agreedPricePaise.toString()).toBe(String(1_860_000n * 100n));
    const savedUnit = await verifyPrisma.unit.findFirstOrThrow({ where: { id: plot1.id } });
    expect(savedUnit.status).toBe('BOOKED');
  } finally {
    await verifyPrisma.$disconnect();
  }
});
