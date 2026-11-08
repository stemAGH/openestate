import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { verhoeffCheckDigit } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// v0.8.0: the Aadhaar guard on custom fields, through the real UI.
//
// A deterrence against ACCIDENTAL storage, not prevention — the wording on
// screen says so, and so do these scenarios (see docs/docs/features-and-usage.md).
//
// Every 12-digit value here is computed: eleven random digits (first digit
// 2-9) plus a Verhoeff check digit. No literal number appears in this file,
// and none is ever a real Aadhaar number.

function aadhaarLike(): string {
  let body = String(2 + Math.floor(Math.random() * 8));
  for (let i = 0; i < 10; i++) body += String(Math.floor(Math.random() * 10));
  return body + verhoeffCheckDigit(body);
}
const wrongCheckDigit = (valid: string) => valid.slice(0, 11) + String((Number(valid[11]) + 1) % 10);
const spaced = (n: string) => `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;

/** Adds a field through Admin → Custom Fields. Returns the POST's response. */
async function addFieldThroughUi(
  page: import('@playwright/test').Page,
  opts: { entity: string; label: string; key: string; allowTwelveDigit?: boolean },
) {
  await page.goto('/admin/custom-fields');
  await page.getByRole('button', { name: opts.entity, exact: true }).click();
  await page.getByRole('button', { name: 'Add Field' }).click();
  await controlAfterLabel(page, 'Label').fill(opts.label);
  await controlAfterLabel(page, 'Field Name').fill(opts.key);
  if (opts.allowTwelveDigit) {
    await page.getByLabel('Allow 12-digit values (bypasses the Aadhaar safety check)').check();
  }
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/custom-fields') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create Field' }).click(),
  ]);
  return res;
}

test('A. the admin form refuses an Aadhaar-named field with the matched word, says what the check can and cannot do, and accepts "uid"', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const stamp = Date.now();
  await login(page, fixture);

  await page.goto('/admin/custom-fields');
  await page.getByRole('button', { name: 'APPLICANT', exact: true }).click();
  await page.getByRole('button', { name: 'Add Field' }).click();

  // The help text is honest about the limits, and never says the check "blocks" anything.
  const help = page.getByTestId('aadhaar-guard-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('safety net against accidental entry');
  await expect(help).toContainText('not a guarantee');
  await expect(help).toContainText('1 in 10');
  await expect(help).toContainText('custom-field values only');
  await expect(help).not.toContainText(/blocks? Aadhaar/i);

  // Blocked name: refused by the server, with the reason shown inline.
  await controlAfterLabel(page, 'Label').fill('Identity number');
  await controlAfterLabel(page, 'Field Name').fill('aadhaar_number');
  const [blocked] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/custom-fields') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create Field' }).click(),
  ]);
  expect(blocked.status()).toBe(400);
  await expect(page.getByText(/can't refer to Aadhaar \(matched "aadhaar"\)/)).toBeVisible();

  // "uid" is deliberately not blocked.
  await controlAfterLabel(page, 'Label').fill(`External UID ${stamp}`);
  await controlAfterLabel(page, 'Field Name').fill(`uid_${stamp}`);
  const [ok] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/custom-fields') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create Field' }).click(),
  ]);
  expect(ok.status()).toBe(201);
});

test('B. the staff inquiry form refuses a checksum-valid number with a clear message; a wrong-check-digit number saves', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const stamp = Date.now();
  const label = `Reference no ${stamp}`;
  try {
    await prisma.customFieldDefinition.create({
      data: { companyId: fixture.companyId, entityType: 'APPLICANT', key: `ref_no_${stamp}`, label, fieldType: 'TEXT' },
    });

    await login(page, fixture);
    await page.goto('/presales/inquiries');
    await page.getByRole('button', { name: 'New inquiry' }).click();
    await controlAfterLabel(page, 'Applicant Name').fill(`E2E Guard Applicant ${stamp}`);
    await controlAfterLabel(page, 'Phone').fill(`9${String(stamp).slice(-9)}`);
    await controlAfterLabel(page, label).fill(spaced(aadhaarLike()));

    const [refused] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    expect(refused.status()).toBe(400);
    await expect(page.getByText(`${label}: this looks like an Aadhaar number`)).toBeVisible();
    expect(await prisma.applicant.count({ where: { companyId: fixture.companyId, name: `E2E Guard Applicant ${stamp}` } })).toBe(0);

    // Same form, a value with the wrong check digit: an ordinary number, saved.
    await controlAfterLabel(page, label).fill(wrongCheckDigit(aadhaarLike()));
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    expect(saved.ok()).toBe(true);
  } finally {
    await prisma.$disconnect();
  }
});

test('C. an exempted field accepts a 12-digit value; the checkbox warns, the list badges the field, and the change is audited', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const stamp = Date.now();
  const label = `Bank account ${stamp}`;
  const toggledLabel = `Toggled account ${stamp}`;
  try {
    await login(page, fixture);

    // Created exempt, through the form.
    await page.goto('/admin/custom-fields');
    await page.getByRole('button', { name: 'APPLICANT', exact: true }).click();
    await page.getByRole('button', { name: 'Add Field' }).click();
    const warning = page.getByTestId('twelve-digit-warning');
    await expect(warning).toContainText('legitimately holds a 12-digit number');
    await expect(warning).toContainText('no longer be checked for accidentally-stored Aadhaar numbers');
    await page.getByRole('button', { name: 'Cancel' }).click();

    const created = await addFieldThroughUi(page, { entity: 'APPLICANT', label, key: `bank_${stamp}`, allowTwelveDigit: true });
    expect(created.status()).toBe(201);
    await expect(page.getByRole('row', { name: new RegExp(label) })).toContainText('12-digit check disabled');

    // The exempt field takes a checksum-valid value through the real inquiry form.
    await page.goto('/presales/inquiries');
    await page.getByRole('button', { name: 'New inquiry' }).click();
    await controlAfterLabel(page, 'Applicant Name').fill(`E2E Bank Applicant ${stamp}`);
    await controlAfterLabel(page, 'Phone').fill(`9${String(stamp).slice(-9)}`);
    await controlAfterLabel(page, label).fill(spaced(aadhaarLike()));
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/inquiries') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create', exact: true }).click(),
    ]);
    expect(saved.ok()).toBe(true);

    // Turned on later, from the list: needs an explicit confirmation, then is audited with the admin as actor.
    const plain = await addFieldThroughUi(page, { entity: 'APPLICANT', label: toggledLabel, key: `toggled_${stamp}` });
    expect(plain.status()).toBe(201);
    const fieldId = ((await plain.json()) as { id: string }).id;
    const row = page.getByRole('row', { name: new RegExp(toggledLabel) });
    await expect(row).not.toContainText('12-digit check disabled');
    await row.getByRole('button', { name: 'Allow 12-digit values' }).click();
    await expect(page.getByTestId('twelve-digit-confirm-panel')).toContainText('no longer be checked');
    const [patched] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/custom-fields/${fieldId}`) && r.request().method() === 'PATCH'),
      page.getByTestId('twelve-digit-confirm').click(),
    ]);
    expect(patched.ok()).toBe(true);
    await expect(row).toContainText('12-digit check disabled');

    const audit = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyId, entityType: 'CustomFieldDefinition', entityId: fieldId, action: 'UPDATE' },
    });
    expect(audit).toHaveLength(1);
    const admin = await prisma.user.findFirstOrThrow({ where: { companyId: fixture.companyId, email: fixture.adminEmail } });
    expect(audit[0].userId).toBe(admin.id);
    expect(audit[0].after).toMatchObject({ allowsTwelveDigitValues: true });

    // And back off, with no confirmation needed: turning the check back ON is the safe direction.
    const [reverted] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/custom-fields/${fieldId}`) && r.request().method() === 'PATCH'),
      row.getByRole('button', { name: 'Re-enable check' }).click(),
    ]);
    expect(reverted.ok()).toBe(true);
    await expect(row).not.toContainText('12-digit check disabled');
  } finally {
    await prisma.$disconnect();
  }
});

test('D. a value already stored is shown masked on the detail screen, the record can still be edited, and the raw value is untouched', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const stamp = Date.now();
  const key = `proj_ref_${stamp}`;
  const label = `Project reference ${stamp}`;
  const stored = spaced(aadhaarLike());
  const last4 = stored.slice(-4);
  const projectName = `E2E Masked Project ${stamp}`;
  try {
    // Pre-guard data: written straight to the database, the way it would
    // already be sitting on an install that upgraded to this release.
    await prisma.customFieldDefinition.create({
      data: { companyId: fixture.companyId, entityType: 'PROJECT', key, label, fieldType: 'TEXT' },
    });
    await prisma.project.create({
      data: { companyId: fixture.companyId, name: projectName, code: `MSK-${stamp}`, customFields: { [key]: stored } },
    });

    await login(page, fixture);
    await page.goto('/inventory/projects');
    await page.getByRole('link', { name: projectName }).click();

    const display = page.locator('dl').filter({ hasText: label });
    await expect(display).toContainText(label);
    await expect(display).toContainText(`XXXX XXXX ${last4}`);
    await expect(display).not.toContainText(stored.slice(0, 9)); // the first eight digits, as written

    // Editing another field still saves: the stored value is resent unchanged and is not re-checked.
    await page.getByRole('button', { name: 'Edit Project' }).click();
    await controlAfterLabel(page, 'Address').fill(`Masked Street ${stamp}`);
    const [patch] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/projects/') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);
    expect(patch.ok()).toBe(true);
    await expect(page.getByText(`Masked Street ${stamp}`)).toBeVisible();
    await expect(display).toContainText(`XXXX XXXX ${last4}`);

    // Masking is a DISPLAY measure: the raw value is still what is stored (and in the API response).
    const row = await prisma.project.findFirstOrThrow({ where: { companyId: fixture.companyId, name: projectName } });
    expect((row.customFields as Record<string, string>)[key]).toBe(stored);
  } finally {
    await prisma.$disconnect();
  }
});
