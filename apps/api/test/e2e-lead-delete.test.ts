/**
 * Deleting a lead (v0.10.1): a soft delete under presales.lead.delete, within
 * the caller's team scope, refused for a lead that converted to a booking,
 * with a required reason and an audit row that holds no phone number. A
 * deleted lead is hidden everywhere until restored, and purged after the
 * company's retention period; its applicant is never deleted.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';
import { makeClients, buildServices, makeUnit } from './helpers/postsales-harness';
import { countBlockedBehind } from './helpers/row-lock-barrier';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
// Strings, not PERMISSIONS.X, so this file compiles before the key exists.
const LEAD_DELETE = 'presales.lead.delete';

let phoneSeq = 0;
const nextPhone = () => `97${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(2, '0')}`;

describeIf('deleting a lead', () => {
  let t: TwoCompanies;
  let admin: Send;
  let noDelete: Send;
  let manager: Send;
  let reportUserId: string;
  let adminUserId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;

  /** A lead created by A's admin, optionally reassigned; returns its id, applicant id and phone. */
  async function lead(opts: { assignTo?: string } = {}) {
    const phone = nextPhone();
    const res = await admin('post', '/inquiries', { applicant: { name: `Lead ${phoneSeq}-${Date.now()}`, primaryPhone: phone }, projectId: t.A.fx.projectId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    if (opts.assignTo) {
      const a = await admin('patch', `/inquiries/${res.body.id}/assign`, { toUserId: opts.assignTo, reason: 'test' });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
    }
    return { id: res.body.id as string, applicantId: res.body.applicantId as string, phone };
  }

  const del = (send: Send, id: string, body: unknown = { reason: 'DUPLICATE' }) => send('delete', `/inquiries/${id}`, body);

  async function bookingFor(inquiryId: string, status?: string) {
    const svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    const b = await svc.bookings.createBooking(
      t.A.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.A.fx), primaryApplicantId: t.A.applicant, coApplicantIds: [], bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: t.A.fx.defaultGstRateId }],
      },
      t.A.fx.userId,
    );
    const link = await admin('post', `/bookings/${b.id}/source-inquiry`, { inquiryId });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    if (status) await t.systemPrisma.booking.update({ where: { id: b.id }, data: { status } });
    return b;
  }

  beforeAll(async () => {
    t = await setupTwoCompanies(`leaddel${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    admin = t.send;
    adminUserId = (await t.systemPrisma.user.findFirst({ where: { email: `e2e-tenant-${t.tag}@test.com` } })).id;
    ({ send: noDelete } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.PRESALES_INQUIRY_UPDATE, PERMISSIONS.PRESALES_INQUIRY_DELETE, PERMISSIONS.ADMIN_TEAM_SCOPE_ALL], `nodel-${t.tag}`));
    const m = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_INQUIRY_READ, LEAD_DELETE], `mgr-${t.tag}`);
    manager = m.send;
    reportUserId = (await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_INQUIRY_READ], `rep-${t.tag}`, { managerId: m.userId })).userId;
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  it('is refused without presales.lead.delete, even with the old presales.inquiry.delete (control: the user reads the lead)', async () => {
    const l = await lead();
    expect((await noDelete('get', `/inquiries/${l.id}`)).status).toBe(200);
    expect((await del(noDelete, l.id)).status).toBe(403);
    expect((await noDelete('get', '/inquiries/deleted')).status).toBe(403);
    expect((await noDelete('post', `/inquiries/${l.id}/restore`)).status).toBe(403);
    expect((await admin('get', `/inquiries/${l.id}`)).status).toBe(200);
  });

  it("a manager with the permission deletes their team's lead, and gets 404 for another team's", async () => {
    const theirs = await lead({ assignTo: reportUserId });
    const others = await lead();
    expect((await del(manager, others.id)).status).toBe(404);
    expect((await admin('get', `/inquiries/${others.id}`)).status).toBe(200);
    const res = await del(manager, theirs.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('requires a reason, and a note when the reason is Other; refuses unknown fields', async () => {
    const l = await lead();
    expect((await del(admin, l.id, {})).status).toBe(400);
    expect((await del(admin, l.id, { reason: 'OTHER' })).status).toBe(400);
    expect((await del(admin, l.id, { reason: 'DUPLICATE', extra: 1 })).status).toBe(400);
    expect((await admin('get', `/inquiries/${l.id}`)).status).toBe(200);
    expect((await del(admin, l.id, { reason: 'OTHER', note: 'met at expo, not a buyer' })).status).toBe(200);
  });

  it('refuses a lead a booking came from, whatever the booking status, and a successful lead; nothing changes', async () => {
    for (const status of [undefined, 'CANCELLED', 'TRANSFERRED_OUT']) {
      const l = await lead();
      await bookingFor(l.id, status);
      const res = await del(admin, l.id);
      expect(res.status, `${status}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(String(res.body.message)).toMatch(/booking/i);
      expect((await admin('get', `/inquiries/${l.id}`)).status).toBe(200);
    }
    // Linked, then its status edited away from Successful: still refused (the booking is what counts).
    const edited = await lead();
    await bookingFor(edited.id);
    await t.systemPrisma.inquiry.update({ where: { id: edited.id }, data: { status: 'CONTINUED' } });
    expect((await del(admin, edited.id)).status).toBe(409);
    const won = await lead();
    await t.systemPrisma.inquiry.update({ where: { id: won.id }, data: { status: 'SUCCESSFUL' } });
    expect((await del(admin, won.id)).status).toBe(409);
  });

  it('a dumped lead follows the same rule (deletable with a reason)', async () => {
    const l = await lead();
    await t.systemPrisma.inquiry.update({ where: { id: l.id }, data: { status: 'DUMPED' } });
    expect((await del(admin, l.id, { reason: 'JUNK_OR_TEST' })).status).toBe(200);
  });

  it('writes an audit row with actor, lead, applicant, reason and counts, and no phone number anywhere', async () => {
    const l = await lead();
    const fu = await admin('post', `/inquiries/${l.id}/follow-ups`, { notes: 'called', nextActionAt: '2027-01-05T10:00:00.000Z' });
    expect(fu.status, JSON.stringify(fu.body)).toBe(201);
    const since = new Date(Date.now() - 1000);
    const res = await del(admin, l.id, { reason: 'OTHER', note: `customer asked; reach on ${l.phone}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await t.systemPrisma.auditLog.findMany({ where: { companyId: t.A.fx.companyId, entityId: l.id, createdAt: { gte: since } } });
    const deleted = rows.find((r: { action: string }) => r.action === 'LEAD_DELETED');
    expect(deleted).toBeDefined();
    expect(deleted.userId).toBe(adminUserId);
    expect(deleted.ipAddress).toBeTruthy();
    expect(deleted.after).toMatchObject({ reason: 'OTHER', applicantId: l.applicantId, followUps: 1 });
    for (const r of rows) expect(JSON.stringify(r), r.action).not.toContain(l.phone.slice(2));
    const stored = await t.systemPrisma.inquiry.findFirst({ where: { id: l.id, deletedAt: { not: null } } });
    expect(stored.deleteNote).not.toContain(l.phone.slice(2));
  });

  it('a deleted lead is hidden from the list, search, detail, its follow-ups and the dashboard; the applicant stays', async () => {
    const l = await lead();
    await admin('post', `/inquiries/${l.id}/follow-ups`, { notes: 'called', nextActionAt: '2027-01-05T10:00:00.000Z' });
    const dashBefore = (await admin('get', '/dashboard')).body;
    expect((await del(admin, l.id)).status).toBe(200);

    expect((await admin('get', `/inquiries/${l.id}`)).status).toBe(404);
    expect((await admin('get', `/inquiries/${l.id}/follow-ups`)).status).toBe(404);
    const search = await admin('get', `/inquiries?search=${l.phone}`);
    expect(search.body.data.map((x: { id: string }) => x.id)).not.toContain(l.id);
    const list = await admin('get', '/inquiries?limit=100');
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(l.id);
    const dashAfter = (await admin('get', '/dashboard')).body;
    expect(dashAfter.mine.openInquiries).toBe(dashBefore.mine.openInquiries - 1);
    // The shared clients hide it from every other reader too (reports, reminders, escalation).
    expect(await t.systemPrisma.inquiry.count({ where: { id: l.id } })).toBe(0);
    expect(await t.systemPrisma.followUp.count({ where: { inquiryId: l.id } })).toBe(0);
    expect((await admin('get', `/applicants/${l.applicantId}`)).status).toBe(200);
    expect((await admin('patch', `/inquiries/${l.id}`, { status: 'CONTINUED' })).status).toBe(404);
  });

  it('holders list deleted leads and restore one: back everywhere, with its follow-ups; audited', async () => {
    const l = await lead();
    await admin('post', `/inquiries/${l.id}/follow-ups`, { notes: 'called', nextActionAt: '2027-01-05T10:00:00.000Z' });
    await del(admin, l.id, { reason: 'DUPLICATE' });
    const listed = await admin('get', '/inquiries/deleted?limit=100');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const row = listed.body.data.find((x: { id: string }) => x.id === l.id);
    expect(row).toMatchObject({ deleteReason: 'DUPLICATE' });
    expect(JSON.stringify(listed.body)).not.toContain(l.phone);

    const res = await admin('post', `/inquiries/${l.id}/restore`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await admin('get', `/inquiries/${l.id}`)).status).toBe(200);
    expect((await admin('get', `/inquiries/${l.id}/follow-ups`)).body).toHaveLength(1);
    const audit = await t.systemPrisma.auditLog.findFirst({ where: { entityId: l.id, action: 'LEAD_RESTORED' } });
    expect(audit).not.toBeNull();
    expect((await admin('post', `/inquiries/${l.id}/restore`)).status).toBe(404);
  });

  /**
   * Forced interleaving: hold the lead's row lock on its own connection, start
   * `first`, wait until it is blocked, start `second`, wait until both are,
   * then release. Postgres grants the lock in queue order, so `first` runs
   * first. Requests are sent with .then() (supertest sends only when awaited).
   */
  async function raceOnLead(leadId: string, first: () => Promise<{ status: number; body: unknown }>, second: () => Promise<{ status: number; body: unknown }>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pidReady!: (pid: number) => void;
    const pidP = new Promise<number>((r) => (pidReady = r));
    const holder = t.systemPrisma.$transaction(async (tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<Array<{ pid: number }>> }) => {
      const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM inquiries WHERE id = ${leadId}::uuid FOR UPDATE`;
      pidReady(Number(row.pid));
      await gate;
    }, { timeout: 60_000 });
    const pid = await pidP;
    const p1 = first();
    const blocked1 = await countBlockedBehind(t.systemPrisma, pid, 1);
    const p2 = second();
    const blocked2 = await countBlockedBehind(t.systemPrisma, pid, 2);
    release();
    await holder;
    const [r1, r2] = await Promise.all([p1, p2]);
    return { blocked1, blocked2, r1, r2 };
  }

  async function unlinkedBooking() {
    const svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    return svc.bookings.createBooking(
      t.A.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.A.fx), primaryApplicantId: t.A.applicant, coApplicantIds: [], bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: t.A.fx.defaultGstRateId }],
      },
      t.A.fx.userId,
    );
  }

  it('forced interleaving, link first: the booking is linked and the delete that waited is refused (409)', async () => {
    const l = await lead();
    const b = await unlinkedBooking();
    const { blocked1, blocked2, r1, r2 } = await raceOnLead(
      l.id,
      () => admin('post', `/bookings/${b.id}/source-inquiry`, { inquiryId: l.id }).then((r) => r),
      () => del(admin, l.id).then((r) => r),
    );
    expect([blocked1, blocked2]).toEqual([1, 2]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(409);
    expect(await t.systemPrisma.inquiry.count({ where: { id: l.id, deletedAt: { not: null } } })).toBe(0);
  }, 60_000);

  it('forced interleaving, delete first: the lead is deleted and the link that waited gets a clean 404', async () => {
    const l = await lead();
    const b = await unlinkedBooking();
    const { blocked1, blocked2, r1, r2 } = await raceOnLead(
      l.id,
      () => del(admin, l.id).then((r) => r),
      () => admin('post', `/bookings/${b.id}/source-inquiry`, { inquiryId: l.id }).then((r) => r),
    );
    expect([blocked1, blocked2]).toEqual([1, 2]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status, JSON.stringify(r2.body)).toBe(404);
    expect((await t.systemPrisma.booking.findUnique({ where: { id: b.id } })).sourceInquiryId).toBeNull();
  }, 60_000);

  it('the purge removes leads deleted longer ago than the retention period (configurable); the applicant and its messages stay', async () => {
    const old = await lead();
    const recent = await lead();
    await admin('post', `/inquiries/${old.id}/follow-ups`, { notes: 'called', nextActionAt: '2027-01-05T10:00:00.000Z' });
    await del(admin, old.id);
    await del(admin, recent.id);
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    await t.systemPrisma.inquiry.updateMany({ where: { id: old.id, deletedAt: { not: null } }, data: { deletedAt: days(31) } });
    await t.systemPrisma.inquiry.updateMany({ where: { id: recent.id, deletedAt: { not: null } }, data: { deletedAt: days(5) } });
    const log = await t.systemPrisma.communicationLog.create({
      data: { companyId: t.A.fx.companyId, inquiryId: old.id, applicantId: old.applicantId, channel: 'SMS', toAddress: 'x', status: 'SENT', body: 'hello' },
    });

    // The app's own class (from dist/), so Nest resolves the same provider.
    const { InquiryService } = createRequire(import.meta.url)('../dist/presales/inquiry.service');
    const inquiries = t.app.get(InquiryService);
    const r1 = await inquiries.purgeDeleted(t.A.fx.companyId);
    expect(r1.purged).toBeGreaterThanOrEqual(1);
    const any = (id: string) => t.systemPrisma.inquiry.count({ where: { id, deletedAt: { not: null } } });
    expect(await any(old.id)).toBe(0);
    expect(await any(recent.id)).toBe(1);
    expect(await t.systemPrisma.followUp.count({ where: { inquiryId: old.id, inquiry: { deletedAt: { not: null } } } })).toBe(0);
    expect(await t.systemPrisma.applicant.count({ where: { id: old.applicantId } })).toBe(1);
    expect(await t.systemPrisma.communicationLog.count({ where: { id: log.id } })).toBe(1);
    expect(await t.systemPrisma.auditLog.count({ where: { companyId: t.A.fx.companyId, action: 'LEADS_PURGED' } })).toBeGreaterThanOrEqual(1);

    // Configurable: with 3 days, the 5-day-old one goes too.
    const cfg = await admin('patch', '/company/config', { leadPurgeAfterDays: 3 });
    expect(cfg.status, JSON.stringify(cfg.body)).toBe(200);
    await inquiries.purgeDeleted(t.A.fx.companyId);
    expect(await any(recent.id)).toBe(0);
  });
});
