/**
 * Editing a lead's details (v0.10.1, Plan A): PATCH /inquiries/:id with the
 * fields the Inquiry Detail "Edit details" card sends. The budget range must
 * stay in order, using the stored value for whichever end isn't sent; the
 * audit row records the previous and new values; team scope and company
 * ownership hold as before.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PERMISSIONS } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('editing a lead', () => {
  let t: TwoCompanies;
  let exec: Send;
  let leadId: string;

  beforeAll(async () => {
    t = await setupTwoCompanies(`leadedit${Date.now()}`);
    ({ send: exec } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.PRESALES_INQUIRY_UPDATE], `exec-${t.tag}`));
    const res = await t.send('post', '/inquiries', {
      applicant: { name: 'Edit Lead', primaryPhone: `90${String(Date.now()).slice(-8)}` }, projectId: t.A.fx.projectId,
      budgetMinPaise: '5000000', budgetMaxPaise: '9000000',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    leadId = res.body.id;
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it('saves source, type, temperature, preferred unit type and budget; GET shows them', async () => {
    const res = await t.send('patch', `/inquiries/${leadId}`, {
      sourceId: t.A.source, inquiryTypeId: t.A.inquiryType, temperatureId: t.A.temperature, preferredUnitTypeId: t.A.unitType,
      budgetMinPaise: '6000000', budgetMaxPaise: '8000000',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const got = (await t.send('get', `/inquiries/${leadId}`)).body;
    expect(got).toMatchObject({ sourceId: t.A.source, inquiryTypeId: t.A.inquiryType, temperatureId: t.A.temperature, preferredUnitTypeId: t.A.unitType });
    expect(String(got.budgetMinPaise)).toBe('6000000');
    expect(String(got.budgetMaxPaise)).toBe('8000000');
  });

  it('refuses a budget range out of order, sent together or one end against the stored other; nothing changes', async () => {
    const both = await t.send('patch', `/inquiries/${leadId}`, { budgetMinPaise: '9000000', budgetMaxPaise: '1000000' });
    expect(both.status).toBe(400);
    expect(String(both.body.message)).toMatch(/budget/i);
    const maxOnly = await t.send('patch', `/inquiries/${leadId}`, { budgetMaxPaise: '1000000' }); // stored min is ₹60,000
    expect(maxOnly.status).toBe(400);
    const minOnly = await t.send('patch', `/inquiries/${leadId}`, { budgetMinPaise: '9900000' }); // stored max is ₹80,000
    expect(minOnly.status).toBe(400);
    const got = (await t.send('get', `/inquiries/${leadId}`)).body;
    expect([String(got.budgetMinPaise), String(got.budgetMaxPaise)]).toEqual(['6000000', '8000000']);
  });

  it('the audit row records the previous and new values of the fields changed', async () => {
    const since = new Date(Date.now() - 1000);
    expect((await t.send('patch', `/inquiries/${leadId}`, { budgetMaxPaise: '8500000' })).status).toBe(200);
    const row = await t.systemPrisma.auditLog.findFirst({
      where: { entityId: leadId, action: 'UPDATE', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' },
    });
    expect(row?.before).toEqual({ budgetMaxPaise: '8000000' });
    expect(row?.after).toMatchObject({ budgetMaxPaise: '8500000' });
  });

  it("is refused outside the caller's team (404) and for another company's source (404)", async () => {
    expect((await exec('patch', `/inquiries/${leadId}`, { budgetMaxPaise: '8600000' })).status).toBe(404);
    const foreign = await t.send('patch', `/inquiries/${leadId}`, { sourceId: t.B.source });
    expect(foreign.status).toBe(404);
  });
});
