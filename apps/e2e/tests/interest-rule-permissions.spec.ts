import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { PERMISSIONS } from '@openestate/shared';
import { seedE2eFixture } from '../fixtures/seed';
import { login } from '../fixtures/actions';
import { API_URL, DATABASE_URL_SYSTEM } from '../playwright.config';

test('restricted Accounts can select rules in the wizard and attach, accrue and remove in the panel', async ({ page }) => {
  const fixture = await seedE2eFixture(DATABASE_URL_SYSTEM);
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const keys = [PERMISSIONS.POSTSALES_INTEREST_MANAGE, PERMISSIONS.POSTSALES_BOOKING_READ,
      PERMISSIONS.POSTSALES_BOOKING_CREATE, PERMISSIONS.POSTSALES_PLAN_READ];
    expect(keys).not.toContain(PERMISSIONS.ADMIN_MASTER_READ);
    const permissions = await prisma.permission.findMany({ where: { key: { in: keys } } });
    expect(permissions).toHaveLength(keys.length);
    const role = await prisma.role.create({ data: {
      companyId: fixture.companyId, name: 'Restricted Accounts', slug: 'restricted-accounts', isSystem: false,
    } });
    await prisma.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })) });
    const user = await prisma.user.update({ where: { companyId_email: { companyId: fixture.companyId, email: fixture.adminEmail } }, data: { roleId: role.id } });
    const rule = await prisma.interestRule.create({ data: {
      companyId: fixture.companyId, name: 'Eligible rule', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY',
    } });
    await prisma.bookingDraft.create({ data: {
      companyId: fixture.companyId, createdById: user.id, label: 'Selector test',
      draftData: { step: 4, coApplicantIds: [], coApplicantNames: [], bookingDate: '2026-10-23',
        basePricePaise: '', planMode: 'template', customInstallments: [] },
    } });
    const loginResponse = page.waitForResponse((r) => r.url().endsWith('/auth/login') && r.request().method() === 'POST');
    await login(page, fixture);
    const { accessToken } = await (await loginResponse).json();
    const headers = { Authorization: `Bearer ${accessToken}` };
    expect((await page.request.get(`${API_URL}/api/v1/masters/interest-rules`, { headers })).status()).toBe(403);
    const deniedRole = await prisma.role.create({ data: {
      companyId: fixture.companyId, name: 'No interest access', slug: 'no-interest-access', isSystem: false,
    } });
    const deniedUser = await prisma.user.create({ data: {
      companyId: fixture.companyId, roleId: deniedRole.id, name: 'Denied user',
      email: `denied-${fixture.adminEmail}`, passwordHash: user.passwordHash, forcePasswordChange: false,
    } });
    const deniedLogin = await page.request.post(`${API_URL}/api/v1/auth/login`, {
      data: { email: deniedUser.email, password: fixture.adminPassword },
    });
    expect(deniedLogin.status()).toBe(200);
    const deniedToken = (await deniedLogin.json()).accessToken;
    expect((await page.request.get(`${API_URL}/api/v1/bookings/interest-rules/attachable`, {
      headers: { Authorization: `Bearer ${deniedToken}` },
    })).status()).toBe(403);
    // Restore the Accounts cookies after the denied user's API login.
    await page.request.post(`${API_URL}/api/v1/auth/login`, {
      data: { email: fixture.adminEmail, password: fixture.adminPassword },
    });
    const lookup = page.waitForResponse((r) => r.url().endsWith('/bookings/interest-rules/attachable'));
    await page.goto('/postsales/bookings/new');
    expect((await lookup).status()).toBe(200);
    await page.getByRole('button', { name: /Resume/ }).click();
    await page.getByLabel('Delay interest').selectOption(rule.id);
    await expect(page.getByLabel('Delay interest')).toHaveValue(rule.id);

    const unit = await prisma.unit.findFirstOrThrow({ where: { companyId: fixture.companyId } });
    const applicant = await prisma.applicant.create({ data: { companyId: fixture.companyId, name: 'Selector applicant', primaryPhone: '9999999999', primaryPhoneNormalized: '9999999999', alternatePhones: [] } });
    const booking = await prisma.booking.create({ data: {
      companyId: fixture.companyId, unitId: unit.id, primaryApplicantId: applicant.id,
      bookingNumber: 'SELECTOR-TEST', status: 'BOOKED', agreedPricePaise: 10000n,
      bookingDate: new Date(), placeOfSupplyStateCode: '09',
    } });
    await page.goto(`/postsales/bookings/${booking.id}/installments`);
    const panel = page.getByRole('region', { name: 'Delay interest' });
    await panel.getByLabel('Interest rule').selectOption(rule.id);
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(panel.getByTestId('interest-rule-current')).toContainText('Eligible rule');
    await panel.getByRole('button', { name: 'Accrue interest now' }).click();
    await expect(panel.getByTestId('interest-message')).toHaveText('No interest is due as of today.');
    await prisma.interestRule.update({ where: { id: rule.id }, data: { isActive: false } });
    await page.reload();
    await expect(panel.getByTestId('interest-rule-current')).toContainText('Eligible rule (18% simple)');
    await expect(panel.getByLabel('Interest rule').locator(`option[value="${rule.id}"]`)).toHaveCount(0);
    await panel.getByLabel('Interest rule').selectOption('NONE');
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(panel.getByTestId('interest-rule-current')).toHaveText('No delay interest.');
  } finally {
    await prisma.$disconnect();
  }
});
