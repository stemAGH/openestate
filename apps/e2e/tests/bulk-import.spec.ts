import { test, expect } from '@playwright/test';
import * as ExcelJS from 'exceljs';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';

// Regression coverage for a "check before building" item: the backend
// (InquiryImportService) has supported bulk Excel inquiry import with
// real row-level validation since Phase 3, but apps/web never called it
// — no upload UI, no downloadable template. Both built here.

async function buildXlsx(rows: Array<Record<string, unknown>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Inquiries');
  sheet.columns = [
    { header: 'Applicant Name', key: 'applicantName' },
    { header: 'Primary Phone', key: 'primaryPhone' },
  ];
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('download the template, upload a bad file (row errors, nothing created), then a good file (creates and appears in the list)', async ({ page }) => {
  const fixture = readFixture('mastersCrud');

  await login(page, fixture);
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'Bulk Import' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download template' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('inquiry-import-template.xlsx');

  const badFile = await buildXlsx([{ applicantName: 'Missing Phone', primaryPhone: '' }]);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'bad-import.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: badFile,
  });
  const [badResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries/import') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Upload' }).click(),
  ]);
  expect(badResponse.ok()).toBe(true); // row errors are a 201 with success:false, not an HTTP failure
  await expect(page.getByText(/row error/)).toBeVisible();

  const applicantName = `E2E Bulk Import Applicant ${Date.now()}`;
  const goodFile = await buildXlsx([{ applicantName, primaryPhone: '9812311111' }]);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'good-import.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: goodFile,
  });
  const [goodResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries/import') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Upload' }).click(),
  ]);
  expect(goodResponse.ok()).toBe(true);
  await expect(page.getByText('Created 1')).toBeVisible();
  await expect(page.getByRole('link', { name: applicantName, exact: true })).toBeVisible();
});
