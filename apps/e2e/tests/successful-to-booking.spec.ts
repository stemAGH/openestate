import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// Follow-Up Page spec gap #3 (docs/plans/followup-spec-gap-analysis.md):
// linking a Successful lead to the real booking it converted to
// (Booking.sourceInquiryId). Real-browser coverage for the part only a
// rendered UI can prove — the "Create Booking" link only appearing once
// the lead is SUCCESSFUL, and BookingWizard picking up the applicant from
// the query params InquiryDetail passes so the rep doesn't have to
// re-search for someone they already have open. The OPEN -> SUCCESSFUL
// flip itself (and the reject-DUMPED/double-attach rules) are covered by
// apps/api's own booking-source-inquiry.test.ts and
// e2e-booking-source-inquiry.test.ts — this link only reaches the wizard
// for an inquiry that's already SUCCESSFUL, so that transition can't be
// exercised from here.
//
// Reuses the 'mastersCrud' fixture's login/project context, but creates
// its own unit directly via Prisma rather than booking the fixture's own
// shared fixture.unitNumber — mirrors stage-raise.spec.ts's exact reason:
// mastersCrud is shared across ~20 spec files, so a spec that books a
// unit through the wizard should never consume the one unit some other
// spec might assume stays AVAILABLE.
test('marking a lead Successful surfaces a Create Booking link that prefills the applicant and links the resulting booking back to the inquiry', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  let unitNumber: string;
  try {
    const floor = await prisma.floor.findFirst({ where: { tower: { projectId: fixture.projectId } } });
    unitNumber = `E2E-SRCINQ-${Date.now()}`;
    await prisma.unit.create({
      data: { companyId: fixture.companyId, projectId: fixture.projectId, shape: 'HIGH_RISE', floorId: floor!.id, number: unitNumber, status: 'AVAILABLE' },
    });
  } finally {
    await prisma.$disconnect();
  }

  await login(page, fixture);

  // A real lead, marked Successful through the real status buttons.
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'Add Inquiry' }).click();
  const applicantName = `E2E Successful Lead ${Date.now()}`;
  await controlAfterLabel(page, 'Applicant Name').fill(applicantName);
  await controlAfterLabel(page, 'Phone').fill(`9${String(Date.now()).slice(-9)}`);
  const [inquiryCreateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(inquiryCreateResponse.ok()).toBe(true);
  const inquiry = (await inquiryCreateResponse.json()) as { id: string };

  await page.getByRole('link', { name: applicantName }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries\/[0-9a-f-]{36}$/);

  await expect(page.getByRole('link', { name: 'Create Booking' })).not.toBeVisible();
  const [statusResponse] = await Promise.all([
    page.waitForResponse((r) => /\/inquiries\/[0-9a-f-]{36}$/.test(r.url()) && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Mark SUCCESSFUL' }).click(),
  ]);
  expect(statusResponse.ok()).toBe(true);
  await expect(page.getByText('Status: SUCCESSFUL')).toBeVisible();

  // The link only exists once the lead is Successful — this is the whole
  // point of the gate.
  const createBookingLink = page.getByRole('link', { name: 'Create Booking' });
  await expect(createBookingLink).toBeVisible();
  await createBookingLink.click();
  await expect(page).toHaveURL(/\/postsales\/bookings\/new\?sourceInquiryId=/);

  // Step 0: the applicant is already picked — no search, no "+ New
  // applicant" — proving the query-param prefill actually wired up,
  // not just that the link carries the right URL.
  await expect(page.getByText(applicantName)).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click(); // step 0 → 1

  const projectSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a project' }) });
  const unitSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select an available unit' }) });
  // The option's visible text is "name (code)", not the plain project
  // name, so an exact-label match never fires — same hasText substring
  // approach as the unit lookup below.
  const projectOption = projectSelect.locator('option', { hasText: fixture.projectName });
  const projectValue = await projectOption.getAttribute('value');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
    projectSelect.selectOption(projectValue!),
  ]);
  const unitOption = unitSelect.locator('option', { hasText: unitNumber });
  const unitValue = await unitOption.getAttribute('value');
  await unitSelect.selectOption(unitValue!);
  await controlAfterLabel(page, 'Agreed base price (₹)').fill('5000000');
  await controlAfterLabel(page, 'GST rate for base price').selectOption({ label: fixture.defaultGstRateLabel });
  await page.getByRole('button', { name: 'Next' }).click(); // step 1 → 2

  await page.getByRole('button', { name: 'Next' }).click(); // step 2 → 3

  await page.getByText('Custom schedule').click();
  await page.getByRole('button', { name: '+ Add installment' }).click();
  await page.getByPlaceholder('Label').fill('Full payment');
  await page.getByPlaceholder('Amount (₹)').fill('5000000');
  await page.getByRole('button', { name: 'Next' }).click(); // step 3 → 4

  // v0.9: the wizard requires an explicit delay-interest choice.
  await page.getByLabel('Delay interest').selectOption('NONE');
  const [bookingResponse, sourceInquiryResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/bookings') && r.request().method() === 'POST'),
    page.waitForResponse((r) => r.url().includes('/source-inquiry') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Confirm & Book' }).click(),
  ]);
  expect(bookingResponse.ok()).toBe(true);
  expect(sourceInquiryResponse.ok()).toBe(true);
  const booking = (await bookingResponse.json()) as { id: string };
  await page.waitForURL(/\/postsales\/bookings\/.+\/installments/);

  // The regression check no browser assertion can substitute for: the
  // booking's own row really does carry the source inquiry.
  const prisma2 = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const saved = await prisma2.booking.findFirst({ where: { id: booking.id } });
    expect(saved!.sourceInquiryId).toBe(inquiry.id);
  } finally {
    await prisma2.$disconnect();
  }
});
