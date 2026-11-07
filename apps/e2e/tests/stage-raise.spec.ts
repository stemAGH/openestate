import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// Construction-linked demand fix — proves what a server-side test can't:
// the schedule view actually renders "not yet due" (new Date(null) would
// otherwise silently render 1970-01-01, no crash, no error — see
// internal plan construction-linked-demand-fix.md §2, consumer #10), and
// the "Construction Stages" raise UI genuinely calls the real endpoint
// and the schedule genuinely updates afterward. Reuses the 'mastersCrud'
// fixture for its login/project context; builds its own template +
// booking + plan directly via Prisma, mirroring project-edit.spec.ts's
// own inline-fixture pattern.

test('an unraised STAGE_LINKED installment shows "not yet due" in the schedule, then a real due date after raising', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  let bookingId: string;
  try {
    const template = await prisma.paymentPlanTemplate.create({
      data: { companyId: fixture.companyId, name: `E2E Stage Template ${Date.now()}` },
    });
    await prisma.paymentPlanMilestone.create({
      data: { companyId: fixture.companyId, templateId: template.id, seq: 1, label: 'On Booking', percent: 40, milestoneType: 'DATE_LINKED', dueOffsetDays: 0 },
    });
    await prisma.paymentPlanMilestone.create({
      data: { companyId: fixture.companyId, templateId: template.id, seq: 2, label: 'Superstructure', percent: 60, milestoneType: 'STAGE_LINKED', graceDaysAfterRaise: 15 },
    });

    const applicant = await prisma.applicant.create({
      data: {
        companyId: fixture.companyId,
        name: `E2E Stage Applicant ${Date.now()}`,
        primaryPhone: `9${String(Date.now()).slice(-9)}`,
        primaryPhoneNormalized: `9${String(Date.now()).slice(-9)}`,
      },
    });
    const floor = await prisma.floor.findFirst({ where: { tower: { projectId: fixture.projectId } } });
    const unit = await prisma.unit.create({
      data: { companyId: fixture.companyId, projectId: fixture.projectId, shape: 'HIGH_RISE', floorId: floor!.id, number: `STG-${Date.now()}`, status: 'AVAILABLE' },
    });
    const booking = await prisma.booking.create({
      data: {
        companyId: fixture.companyId,
        unitId: unit.id,
        primaryApplicantId: applicant.id,
        bookingNumber: `STG-BOOKING-${Date.now()}`,
        agreedPricePaise: BigInt(10_00_000_00),
        bookingDate: new Date('2027-01-01'),
        placeOfSupplyStateCode: '09',
      },
    });
    bookingId = booking.id;
    const plan = await prisma.paymentPlan.create({
      data: { companyId: fixture.companyId, bookingId, templateId: template.id, name: template.name, isCustom: false, version: 1 },
    });
    await prisma.installment.create({
      data: { companyId: fixture.companyId, bookingId, planId: plan.id, seq: 1, label: 'On Booking', milestoneType: 'DATE_LINKED', milestoneSeq: 1, dueDate: new Date('2027-01-01'), amountPaise: BigInt(4_00_000_00), milestonePercent: 40 },
    });
    await prisma.installment.create({
      data: { companyId: fixture.companyId, bookingId, planId: plan.id, seq: 2, label: 'Superstructure', milestoneType: 'STAGE_LINKED', milestoneSeq: 2, dueDate: null, amountPaise: BigInt(6_00_000_00), milestonePercent: 60 },
    });

    await login(page, fixture);

    // Schedule view: the unraised installment must show "Not yet due", not
    // a formatted date and definitely not 1970-01-01.
    await page.goto(`/postsales/bookings/${bookingId}/installments`);
    await expect(page.getByText('Superstructure')).toBeVisible();
    await expect(page.getByText(/Not yet due/i)).toBeVisible();
    await expect(page.getByText('1/1/1970')).not.toBeVisible();
    await expect(page.getByText('1/1/70')).not.toBeVisible();

    // Raise UI: mark the stage complete from the project's Construction
    // Stages panel.
    await page.goto(`/inventory/projects/${fixture.projectId}`);
    await expect(page.getByText(/Superstructure.*1 booking/)).toBeVisible();
    await page.getByRole('button', { name: 'Mark stage complete' }).click();
    await page.getByLabel('Stage completed on').fill('2027-06-01');

    const [raiseResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/stage-raises') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Confirm raise' }).click(),
    ]);
    expect(raiseResponse.ok()).toBe(true);
    await expect(page.getByText('1 installment raised')).toBeVisible();
    await expect(page.getByText('No unraised construction stages in this project.')).toBeVisible();

    // Schedule view again: now shows the real, raised due date
    // (en-IN locale formats as D/M/YYYY: stageCompletedOn 2027-06-01 +
    // graceDaysAfterRaise 15 = 2027-06-16 -> "16/6/2027").
    await page.goto(`/postsales/bookings/${bookingId}/installments`);
    await expect(page.getByText('16/6/2027')).toBeVisible();
    await expect(page.getByText(/Not yet due/i)).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
