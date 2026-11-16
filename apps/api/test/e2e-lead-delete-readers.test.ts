/**
 * Deleted leads (v0.10.1), reader by reader. Soft delete is applied by a
 * database-client extension; this file proves each reader that matters
 * leaves a deleted lead out (or, where noted, deliberately keeps it), using
 * a company that holds only this file's leads so before/after is exact:
 *
 * - every pre-sales report (JSON) and the inquiries CSV export: the lead is
 *   counted before, not after, and counted again after a restore;
 * - the dashboard counts;
 * - the escalation job: a deleted overdue lead is not escalated;
 * - the duplicate warning on a new inquiry: still raised for a deleted
 *   lead's phone (the match is on the person, who is never deleted);
 * - applicant merge: moves deleted leads to the survivor too;
 * - custom-field value count and purge (raw SQL): include deleted leads,
 *   so a restored lead never brings back a purged value;
 * - the company-references upgrade report (raw SQL): still counts a deleted
 *   lead's stored reference (it reports stored rows, deleted or not).
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const appRequire = createRequire(import.meta.url);

const REPORTS = [
  'daily-inquiries', 'funnel', 'source-wise', 'budget-band', 'ageing', 'staff-performance', 'manager-wise',
  'inquiries-export', 'leads-by-stage', 'enquiry-type', 'dump-report', 'site-visit', 'stage-transitions',
  'stage-velocity', 'follow-up-overdue', 'follow-up-delay', 'supervisor-review-queue', 'daily-work', 'communication-type',
];
// Reports whose rules include an OPEN lead with a source, type, budget, stage, an overdue
// follow-up and a logged site visit: each must count the test lead before it is deleted.
const MUST_COUNT = [
  'daily-inquiries', 'funnel', 'source-wise', 'budget-band', 'ageing', 'inquiries-export', 'leads-by-stage',
  'enquiry-type', 'site-visit', 'follow-up-overdue',
];

describeIf('deleted leads: every reader', () => {
  let t: TwoCompanies;
  let lead: { id: string; applicantId: string; name: string; phone: string };

  const get = async (url: string) => {
    const res = await t.send('get', url);
    expect(res.status, `${url}: ${res.text.slice(0, 300)}`).toBe(200);
    return res.text;
  };
  const snapshot = async () => {
    const out: Record<string, string> = {};
    for (const r of REPORTS) {
      // A wide range where the report takes one; some reports have no date range (400 on unknown keys).
      const url = `/reports/presales/${r}`;
      const ranged = await t.send('get', `${url}?from=2020-01-01&to=2030-12-31`);
      out[r] = ranged.status === 400 ? await get(url) : await get(`${url}?from=2020-01-01&to=2030-12-31`);
    }
    out['inquiries-export.csv'] = await get('/reports/presales/inquiries-export?format=csv&from=2020-01-01&to=2030-12-31');
    out.dashboard = JSON.stringify((await t.send('get', '/dashboard')).body.mine);
    return out;
  };
  const del = (id: string) => t.send('delete', `/inquiries/${id}`, { reason: 'DUPLICATE' });

  beforeAll(async () => {
    t = await setupTwoCompanies(`leadrd${Date.now()}`);
    const phone = `96${String(Date.now()).slice(-8)}`;
    const name = `Reader Lead ${Date.now()}`;
    const siteVisit = await t.systemPrisma.followUpType.create({ data: { companyId: t.A.fx.companyId, name: 'Site Visit' } }).catch(
      async () => t.systemPrisma.followUpType.findFirst({ where: { companyId: t.A.fx.companyId, name: 'Site Visit' } }),
    );
    const res = await t.send('post', '/inquiries', {
      applicant: { name, primaryPhone: phone }, projectId: t.A.fx.projectId, sourceId: t.A.source, inquiryTypeId: t.A.inquiryType,
      temperatureId: t.A.temperature, budgetMinPaise: '5000000', budgetMaxPaise: '9000000',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    lead = { id: res.body.id, applicantId: res.body.applicantId, name, phone };
    const fu = await t.send('post', `/inquiries/${lead.id}/follow-ups`, {
      typeId: siteVisit.id, notes: 'visited', scheduledAt: '2026-11-10T10:00:00.000Z', venue: 'Site office', nextActionAt: '2027-01-05T10:00:00.000Z',
    });
    expect(fu.status, JSON.stringify(fu.body)).toBe(201);
    // Overdue now, so it qualifies for the overdue report and for escalation.
    await t.systemPrisma.inquiry.update({ where: { id: lead.id }, data: { nextFollowupAt: new Date('2026-11-01T10:00:00.000Z') } });
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it('every pre-sales report, the CSV export and the dashboard leave a deleted lead out, and count it again after a restore', async () => {
    const before = await snapshot();
    for (const r of MUST_COUNT) expect(before[r], `${r} counts the lead before`).not.toBe('');
    expect((await del(lead.id)).status).toBe(200);
    const after = await snapshot();
    for (const [k, v] of Object.entries(after)) {
      expect(v, k).not.toContain(lead.id);
      expect(v, k).not.toContain(lead.name);
      expect(v, k).not.toContain(lead.phone.slice(-6));
    }
    for (const r of [...MUST_COUNT, 'inquiries-export.csv', 'dashboard']) expect(after[r], `${r} changes when the lead is deleted`).not.toBe(before[r]);
    expect((await t.send('post', `/inquiries/${lead.id}/restore`)).status).toBe(200);
    const restored = await snapshot();
    for (const k of Object.keys(before)) expect(restored[k], `${k} after restore`).toBe(before[k]);
  });

  it('the escalation job does not escalate a deleted overdue lead (control: the same lead, restored, is escalated)', async () => {
    const { EscalationService } = appRequire('../dist/presales/escalation.service');
    const escalation = t.app.get(EscalationService);
    await t.systemPrisma.inquiry.update({ where: { id: lead.id }, data: { lastEscalatedAt: null } });
    expect((await del(lead.id)).status).toBe(200);
    await escalation.runForCompany(t.A.fx.companyId);
    const deleted = await t.systemPrisma.inquiry.findFirst({ where: { id: lead.id, deletedAt: { not: null } } });
    expect(deleted.lastEscalatedAt).toBeNull();
    expect((await t.send('post', `/inquiries/${lead.id}/restore`)).status).toBe(200);
    await escalation.runForCompany(t.A.fx.companyId);
    expect((await t.systemPrisma.inquiry.findUnique({ where: { id: lead.id } })).lastEscalatedAt).not.toBeNull();
  });

  it("a deleted lead's phone still raises the duplicate warning on a new inquiry (the person is never deleted)", async () => {
    const phone = `95${String(Date.now()).slice(-8)}`;
    const first = await t.send('post', '/inquiries', { applicant: { name: 'Dup Person', primaryPhone: phone } });
    expect((await del(first.body.id)).status).toBe(200);
    const again = await t.send('post', '/inquiries', { applicant: { name: 'Dup Person Again', primaryPhone: phone } });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect([again.body.applicantId, ...(again.body.possibleDuplicateApplicantIds ?? [])]).toContain(first.body.applicantId);
  });

  it("merging applicants moves the merged person's deleted leads to the survivor too", async () => {
    const a = await t.send('post', '/inquiries', { applicant: { name: 'Merge From', primaryPhone: `94${String(Date.now()).slice(-8)}` } });
    const b = await t.send('post', '/inquiries', { applicant: { name: 'Merge Into', primaryPhone: `93${String(Date.now()).slice(-8)}` } });
    expect((await del(a.body.id)).status).toBe(200);
    const merged = await t.send('post', `/applicants/${b.body.applicantId}/merge/${a.body.applicantId}`);
    expect(merged.status, JSON.stringify(merged.body)).toBeLessThan(300);
    const moved = await t.systemPrisma.inquiry.findFirst({ where: { id: a.body.id, deletedAt: { not: null } } });
    expect(moved.applicantId).toBe(b.body.applicantId);
  });

  it('custom-field value count and purge include deleted leads, so a restore never brings a purged value back', async () => {
    const def = await t.send('post', '/custom-fields', { entityType: 'INQUIRY', key: `rd_${Date.now()}`, label: 'Reader field', fieldType: 'TEXT' });
    expect(def.status, JSON.stringify(def.body)).toBe(201);
    const l = await t.send('post', '/inquiries', { applicant: { name: 'CF Lead', primaryPhone: `92${String(Date.now()).slice(-8)}` }, customFields: { [def.body.key]: 'x' } });
    expect(l.status, JSON.stringify(l.body)).toBe(201);
    expect((await del(l.body.id)).status).toBe(200);
    const count = await t.send('get', `/custom-fields/${def.body.id}/value-count`);
    expect(count.body.affectedRows ?? count.body.count).toBe(1);
    expect((await t.send('delete', `/custom-fields/${def.body.id}`)).status).toBeLessThan(300);
    const purge = await t.send('post', `/custom-fields/${def.body.id}/purge`, { confirmKey: def.body.key });
    expect(purge.status, JSON.stringify(purge.body)).toBeLessThan(300);
    expect((await t.send('post', `/inquiries/${l.body.id}/restore`)).status).toBe(200);
    const row = await t.systemPrisma.inquiry.findUnique({ where: { id: l.body.id } });
    expect(Object.keys((row.customFields ?? {}) as object)).not.toContain(def.body.key);
  });

  it("the company-references upgrade report still counts a deleted lead's stored reference", async () => {
    const l = await t.send('post', '/inquiries', { applicant: { name: 'Xref Lead', primaryPhone: `91${String(Date.now()).slice(-8)}` } });
    expect((await del(l.body.id)).status).toBe(200);
    expect(await t.crossReferencesOfA()).toEqual([]);
    // A stored reference to company B's project, as an older release could leave one.
    await t.systemPrisma.inquiry.updateMany({ where: { id: l.body.id, deletedAt: { not: null } }, data: { projectId: t.B.fx.projectId } });
    expect(await t.crossReferencesOfA()).toContainEqual({ column: 'inquiries.project_id', count: 1 });
  });
});
