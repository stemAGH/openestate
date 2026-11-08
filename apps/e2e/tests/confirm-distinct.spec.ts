import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * Item 7 (phone as universal identifier): the confirm-distinct UI on
 * Inquiries.tsx's duplicate-warning banner. Creating a second inquiry with
 * a NEW applicant sharing an existing applicant's phone number surfaces
 * the candidate by name/phone with a "Confirm distinct" button; clicking
 * it must both remove the candidate from the banner (immediate UI state)
 * AND persist an ApplicantDistinctPair row server-side (the actual
 * suppression mechanism — GET /applicants/:id/duplicates is what reads
 * it back, not anything rendered on this page), so this spec checks both:
 * the visible DOM change, and a direct DB read for the row itself, the
 * same "UI + direct DB read" pattern plc-booking.spec.ts already uses for
 * server-side effects the page itself never displays.
 *
 * Reuses the mastersCrud fixture's admin login — super_admin/company_admin
 * hold every permission automatically (roles.ts), so PRESALES_APPLICANT_MERGE
 * (the same trust level as merge — deciding applicant identity) is covered
 * without needing a dedicated role/user like empty-team-hint.spec.ts did
 * for its narrower manager-vs-admin RBAC boundary.
 */
test('creating a second inquiry with a duplicate phone shows the candidate; confirming distinct removes it and persists the decision', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const tag = Date.now();
  const phone = '9800900001';
  const firstName = `E2E Distinct First ${tag}`;
  const secondName = `E2E Distinct Second ${tag}`;

  try {
    await login(page, fixture);
    await page.goto('/presales/inquiries');

    // First inquiry: brand-new applicant, no existing match yet.
    await page.getByRole('button', { name: 'New inquiry' }).click();
    await controlAfterLabel(page, 'Applicant Name').fill(firstName);
    await controlAfterLabel(page, 'Phone').fill(phone);
    const [firstRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create' }).click(),
    ]);
    expect(firstRes.ok()).toBe(true);
    await expect(page.getByText('possible duplicate applicant(s) were found')).not.toBeVisible();

    // Second inquiry: a NEW applicant sharing the same phone — must
    // surface the duplicate-warning banner naming the first applicant.
    await page.getByRole('button', { name: 'New inquiry' }).click();
    await controlAfterLabel(page, 'Applicant Name').fill(secondName);
    await controlAfterLabel(page, 'Phone').fill(phone);
    const [secondRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create' }).click(),
    ]);
    expect(secondRes.ok()).toBe(true);

    await expect(page.getByText('possible duplicate applicant(s) were found')).toBeVisible();
    const candidateRow = page.locator('li', { hasText: firstName });
    await expect(candidateRow).toBeVisible();
    await expect(candidateRow).toContainText(phone);

    const confirmButton = candidateRow.getByRole('button', { name: 'Confirm distinct' });
    const [confirmRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/confirm-distinct') && r.request().method() === 'POST'),
      confirmButton.click(),
    ]);
    expect(confirmRes.ok()).toBe(true);

    // The banner is gated on duplicateCandidates.length > 0 — confirming
    // the only candidate removes it entirely, not just the one row.
    await expect(page.getByText('possible duplicate applicant(s) were found')).not.toBeVisible();

    // Direct DB read: the actual suppression mechanism (a persisted
    // ApplicantDistinctPair row), not anything this page renders.
    const first = await prisma.applicant.findFirstOrThrow({ where: { companyId: fixture.companyId, name: firstName } });
    const second = await prisma.applicant.findFirstOrThrow({ where: { companyId: fixture.companyId, name: secondName } });
    const [applicantAId, applicantBId] = first.id < second.id ? [first.id, second.id] : [second.id, first.id];
    const pair = await prisma.applicantDistinctPair.findUnique({
      where: { companyId_applicantAId_applicantBId: { companyId: fixture.companyId, applicantAId, applicantBId } },
    });
    expect(pair).not.toBeNull();
  } finally {
    await prisma.$disconnect();
  }
});
