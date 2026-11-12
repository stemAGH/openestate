/**
 * A write that names another row by id (a project, a user, a master
 * record…) only accepts a row of the caller's own company.
 *
 * Row-level security hides other companies' rows from reads, but a
 * foreign key on write is checked by Postgres regardless of RLS: an id
 * from another company was stored as given. Each case sends a valid
 * request from company A with exactly one id taken from company B and
 * expects a 404 that names the field; the last test checks the database
 * holds no row of A that points at another company's row. The post-sales
 * services are covered in e2e-tenant-ownership-postsales.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import { makeUnit } from './helpers/postsales-harness';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const TAG = `${Date.now()}-${process.pid}`;
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-tenant-ownership-${TAG}-`;

describeIf('e2e tenant ownership of ids named in a request', () => {
  let t: TwoCompanies;
  beforeAll(async () => { t = await setupTwoCompanies(TAG); }, 180_000);
  afterAll(async () => { await t?.cleanup(); });

  it('assignment pool: a user or project of another company is refused; own rows still work', async () => {
    const { A, B, send, refused } = t;
    refused(await send('put', `/projects/${A.fx.projectId}/assignment-pool/${B.user}`, { isActive: true }), /user not found/i);
    refused(await send('put', `/projects/${B.fx.projectId}/assignment-pool/${A.user}`, { isActive: true }), /project not found/i);
    expect((await send('put', `/projects/${A.fx.projectId}/assignment-pool/${A.user}`, { isActive: true })).status).toBe(200);
  });

  it('new inquiry: project, source, inquiry type, temperature and preferred unit type must be the company’s own', async () => {
    const { A, B, send, refused } = t;
    const base = (n: number) => ({ applicant: { name: `XT ${n}`, primaryPhone: `981117780${n}` }, projectId: A.fx.projectId });
    refused(await send('post', '/inquiries', { ...base(1), projectId: B.fx.projectId }), /project not found/i);
    refused(await send('post', '/inquiries', { ...base(2), sourceId: B.source }), /source not found/i);
    refused(await send('post', '/inquiries', { ...base(3), inquiryTypeId: B.inquiryType }), /inquiry type not found/i);
    refused(await send('post', '/inquiries', { ...base(4), temperatureId: B.temperature }), /temperature not found/i);
    refused(await send('post', '/inquiries', { ...base(5), preferredUnitTypeId: B.unitType }), /unit type not found/i);
    const ok = await send('post', '/inquiries', { ...base(6), sourceId: A.source, inquiryTypeId: A.inquiryType, temperatureId: A.temperature, preferredUnitTypeId: A.unitType });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('inquiry update and follow-up: the same fields, and the follow-up type', async () => {
    const { A, B, send, refused, own } = t;
    const url = `/inquiries/${own.inquiry}`;
    refused(await send('patch', url, { projectId: B.fx.projectId }), /project not found/i);
    refused(await send('patch', url, { sourceId: B.source }), /source not found/i);
    refused(await send('patch', url, { inquiryTypeId: B.inquiryType }), /inquiry type not found/i);
    refused(await send('patch', url, { temperatureId: B.temperature }), /temperature not found/i);
    refused(await send('patch', url, { preferredUnitTypeId: B.unitType }), /unit type not found/i);
    expect((await send('patch', url, { temperatureId: A.temperature })).status).toBe(200);
    refused(await send('post', `${url}/follow-ups`, { typeId: B.followUpType, nextActionAt: '2026-12-01T05:00:00.000Z' }), /follow-up type not found/i);
    expect((await send('post', `${url}/follow-ups`, { typeId: A.followUpType, nextActionAt: '2026-12-01T05:00:00.000Z' })).status).toBe(201);
  });

  it('inbound lead: a project of another company is refused', async () => {
    const res = await request(t.app.getHttpServer()).post('/api/v1/leads/inbound').set('X-Api-Key', t.own.leadKey).send({ n: 'Inbound', p: '9811177709', project: t.B.fx.projectId });
    t.refused(res, /project not found/i);
  });

  it('projects and units: project type, area, unit type, PLC type and charge type must be the company’s own', async () => {
    const { A, B, send, refused, systemPrisma, tag } = t;
    const areaB = (await systemPrisma.project.findUnique({ where: { id: B.fx.projectId } })).areaLocationId;
    refused(await send('post', '/projects', { name: `XT ${tag}`, code: `XT${tag.slice(-5)}`, projectTypeId: B.projectType }), /project type not found/i);
    refused(await send('post', '/projects', { name: `XU ${tag}`, code: `XU${tag.slice(-5)}`, areaLocationId: areaB }), /area.*not found/i);
    refused(await send('patch', `/projects/${A.fx.projectId}`, { areaLocationId: areaB }), /area.*not found/i);
    refused(await send('patch', `/projects/${A.fx.projectId}`, { projectTypeId: B.projectType }), /project type not found/i);
    refused(await send('post', `/projects/${A.fx.projectId}/units/bulk-generate`, { towerId: A.fx.towerId, floorStart: 1, floorEnd: 1, unitsPerFloor: 1, unitPrefix: 'XT-', unitTypeId: B.unitType }), /unit type not found/i);
    const freeUnit = await makeUnit(systemPrisma, A.fx);
    refused(await send('patch', `/projects/${A.fx.projectId}/units/${freeUnit}`, { unitTypeId: B.unitType }), /unit type not found/i);
    refused(await send('post', `/projects/${A.fx.projectId}/units/${freeUnit}/plcs`, { plcTypeId: B.plcType, amountPaise: '100' }), /plc type not found/i);
    refused(await send('post', `/projects/${A.fx.projectId}/units/${freeUnit}/charges`, { chargeTypeId: B.chargeType, amountPaise: '100' }), /charge type not found/i);
    expect((await send('patch', `/projects/${A.fx.projectId}/units/${freeUnit}`, { unitTypeId: A.unitType })).status).toBe(200);
  });

  it('new units (on a floor, or a plot): the unit type must be the company’s own', async () => {
    const { A, B, send, refused, systemPrisma, tag } = t;
    refused(await send('post', `/projects/${A.fx.projectId}/units/floors/${A.fx.floorId}`, { number: `XF-${tag.slice(-6)}`, unitTypeId: B.unitType }), /unit type not found/i);
    const land = await systemPrisma.project.create({
      data: { companyId: A.fx.companyId, name: `Land ${tag}`, code: `L${tag.slice(-6)}`, shape: 'LAND_BASED', areaLocationId: (await systemPrisma.project.findUnique({ where: { id: A.fx.projectId } })).areaLocationId },
    });
    refused(await send('post', `/projects/${land.id}/units/land-based`, { number: 'XP-1', unitTypeId: B.unitType, landAreaEntered: 100, landAreaEnteredUnit: 'SQYD', rateUnit: 'SQYD' }), /unit type not found/i);
  });

  it('masters: a charge type’s GST rate must be the company’s own', async () => {
    const { A, B, send, refused, tag } = t;
    refused(await send('post', '/masters/charge-types', { name: `CT XT ${tag}`, gstRateId: B.fx.defaultGstRateId }), /gst rate not found/i);
    refused(await send('patch', `/masters/charge-types/${A.chargeType}`, { gstRateId: B.fx.defaultGstRateId }), /gst rate not found/i);
  });

  it('broker commission rule and construction update: the project must be the company’s own', async () => {
    const { A, B, send, refused } = t;
    refused(await send('post', `/brokers/${A.broker}/commission-rules`, { brokerId: A.broker, commissionType: 'FLAT_PERCENT', flatPercent: 1, projectId: B.fx.projectId }), /project not found/i);
    refused(await send('post', '/admin/construction-updates', { projectId: B.fx.projectId, title: 'XT', publishedAt: '2026-11-12' }), /project not found/i);
  });

  it('the check itself filters by company, even on a client that bypasses row-level security', async () => {
    const { A, B, systemPrisma } = t;
    const require = createRequire(import.meta.url);
    const { assertOwnedByCompany } = require('../dist/common/tenant-ownership');
    // systemPrisma is not subject to RLS, so only the companyId filter can refuse B's rows here.
    await expect(assertOwnedByCompany(systemPrisma, A.fx.companyId, [['user', B.user, 'User']])).rejects.toThrow(/User not found/);
    await expect(assertOwnedByCompany(systemPrisma, A.fx.companyId, [['applicant', [A.applicant, B.applicant], 'Co-applicant']])).rejects.toThrow(/Co-applicant not found/);
    await expect(assertOwnedByCompany(systemPrisma, A.fx.companyId, [['user', A.user, 'User'], ['applicant', [A.applicant], 'Applicant']])).resolves.toBeUndefined();
  });

  it('no row of company A points at another company’s row', async () => {
    expect(await t.crossReferencesOfA()).toEqual([]);
  });
});
