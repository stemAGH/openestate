import { test, expect, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// The booking wizard books atomically (POST /bookings/with-plan). It shows
// the GST-inclusive total from the quote and checks the plan against it.
// The earlier failing case (installments adding up to the price EXCLUDING
// GST) can no longer leave a booking without a plan. A booking already
// stuck without a plan gets a "Create payment plan" panel on its schedule.

const BASE_RUPEES = '1000000'; // ₹10,00,000; with 5% GST ₹10,50,000

test.describe.configure({ mode: 'serial' });

test.describe('atomic booking', () => {
  const fixture = readFixture('atomicBooking');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  let gst5: string;
  const units: Record<string, string> = {};

  test.beforeAll(async () => {
    gst5 = (await prisma.gstRate.create({
      data: { companyId: fixture.companyId, rate: 5, description: 'GST 5% atomic', effectiveFrom: new Date('2019-04-01') },
    })).id;
    const template = await prisma.unit.findFirstOrThrow({ where: { companyId: fixture.companyId } });
    for (const key of ['clean', 'refused', 'stuck']) {
      const u = await prisma.unit.create({
        data: {
          companyId: fixture.companyId,
          projectId: template.projectId,
          floorId: template.floorId,
          shape: 'HIGH_RISE',
          number: `AT-${key}-${Date.now()}`,
          status: 'AVAILABLE',
          baseRatePaise: 0n,
        },
      });
      units[key] = u.id;
    }
  });

  test.afterAll(async () => {
    await prisma.gstRate.update({ where: { id: gst5 }, data: { rate: 5 } });
    await prisma.$disconnect();
  });

  async function wizardToPlanStep(page: Page, unitId: string) {
    await page.goto('/postsales/bookings/new');
    await page.getByRole('button', { name: '+ New applicant not found above' }).click();
    await page.getByPlaceholder('Full name').fill(`E2E Atomic ${Date.now()}`);
    await page.getByPlaceholder('Phone', { exact: true }).fill(`9${Math.floor(100000000 + Math.random() * 900000000)}`);
    await page.getByRole('button', { name: 'Create & select' }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    const projectSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select a project' }) });
    const unitSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select an available unit' }) });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/units?status=AVAILABLE')),
      projectSelect.selectOption({ index: 1 }),
    ]);
    await expect(unitSelect.locator(`option[value="${unitId}"]`)).toHaveCount(1);
    await unitSelect.selectOption(unitId);
    await controlAfterLabel(page, 'Agreed base price (₹)').fill(BASE_RUPEES);
    await controlAfterLabel(page, 'GST rate for base price').selectOption(gst5);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click(); // no co-applicants
    await expect(page.getByTestId('total-payable')).toHaveText('Total payable (GST included): ₹10,50,000.00');
  }

  test('the earlier failing case now books cleanly', async ({ page }) => {
    await login(page, fixture);
    await wizardToPlanStep(page, units.clean);

    // The old mistake: an installment for the price EXCLUDING GST.
    await page.getByText('Custom schedule').click();
    await page.getByRole('button', { name: '+ Add installment' }).click();
    await page.getByPlaceholder('Label').fill('Full payment');
    await page.getByPlaceholder('Amount (₹)').fill(BASE_RUPEES);
    await expect(page.getByTestId('plan-total-check')).toContainText('₹50,000.00 still to schedule');
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

    await page.getByPlaceholder('Amount (₹)').fill('1050000');
    await expect(page.getByTestId('plan-total-check')).toContainText('Matches the total');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByTestId('confirm-total-payable')).toHaveText('₹10,50,000.00');
    await page.getByLabel('Delay interest').selectOption('NONE');

    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/bookings/with-plan') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Confirm & Book' }).click(),
    ]);
    expect(res.status()).toBe(201);
    await page.waitForURL(/\/postsales\/bookings\/.+\/installments/);
    await expect(page.getByRole('cell', { name: 'Full payment' })).toBeVisible();

    const bookings = await prisma.booking.findMany({ where: { unitId: units.clean }, include: { paymentPlans: true } });
    expect(bookings).toHaveLength(1);
    expect(bookings[0].agreedPricePaise).toBe(1_050_000_00n);
    expect(bookings[0].paymentPlans).toHaveLength(1);
  });

  test('a refused booking shows the reason and leaves no booking', async ({ page }) => {
    await login(page, fixture);
    await wizardToPlanStep(page, units.refused);
    await page.getByText('Custom schedule').click();
    await page.getByRole('button', { name: '+ Add installment' }).click();
    await page.getByPlaceholder('Label').fill('Full payment');
    await page.getByPlaceholder('Amount (₹)').fill('1050000');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Delay interest').selectOption('NONE');

    // The GST rate changes after the quote, so the plan no longer matches the price.
    await prisma.gstRate.update({ where: { id: gst5 }, data: { rate: 12 } });
    try {
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/bookings/with-plan') && r.request().method() === 'POST'),
        page.getByRole('button', { name: 'Confirm & Book' }).click(),
      ]);
      expect(res.status()).toBe(409);
      await expect(page.getByText(/The price changed since the quote: quoted ₹10,50,000.00, now ₹11,20,000.00/)).toBeVisible();
      await expect(page).toHaveURL(/\/postsales\/bookings\/new/);
    } finally {
      await prisma.gstRate.update({ where: { id: gst5 }, data: { rate: 5 } });
    }
    expect(await prisma.booking.count({ where: { unitId: units.refused } })).toBe(0);
    expect((await prisma.unit.findUniqueOrThrow({ where: { id: units.refused } })).status).toBe('AVAILABLE');
  });

  test('a booking stuck without a plan gets a plan from its schedule', async ({ page }) => {
    // The state the old two-step wizard could leave: booked, no plan.
    const applicant = await prisma.applicant.create({
      data: { companyId: fixture.companyId, name: 'Stuck applicant', primaryPhone: '9888877777', primaryPhoneNormalized: '9888877777', alternatePhones: [] },
    });
    const booking = await prisma.booking.create({
      data: {
        companyId: fixture.companyId, unitId: units.stuck, primaryApplicantId: applicant.id,
        bookingNumber: `STUCK-${Date.now()}`, status: 'BOOKED', agreedPricePaise: 1_050_000_00n,
        bookingDate: new Date(), placeOfSupplyStateCode: '09',
      },
    });
    await prisma.unit.update({ where: { id: units.stuck }, data: { status: 'BOOKED' } });

    await login(page, fixture);
    await page.goto(`/postsales/bookings/${booking.id}/installments`);
    const panel = page.getByRole('region', { name: 'This booking has no payment plan' });
    await expect(panel).toContainText('₹10,50,000.00 (GST included)');
    await panel.getByRole('button', { name: '+ Add installment' }).click();
    await panel.getByPlaceholder('Label').fill('Balance');
    await panel.getByPlaceholder('Amount (₹)').fill('1000000');
    await expect(panel.getByRole('button', { name: 'Create payment plan' })).toBeDisabled();
    await panel.getByPlaceholder('Amount (₹)').fill('1050000');
    await panel.getByRole('button', { name: 'Create payment plan' }).click();
    await expect(page.getByRole('cell', { name: 'Balance' })).toBeVisible();
    await expect(panel).toHaveCount(0);
    expect(await prisma.paymentPlan.count({ where: { bookingId: booking.id, isActive: true } })).toBe(1);
  });
});
