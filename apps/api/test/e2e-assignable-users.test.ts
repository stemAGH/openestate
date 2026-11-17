/**
 * QA-003: Reassign offered users the server then refused. GET
 * /inquiries/:id/assignable-users lists exactly the users a lead can be
 * assigned to by this caller: active, in the caller's team scope, and with a
 * role that can open leads (presales.inquiry.read). Assigning applies the same
 * rule: a user whose role can't open leads, or who is deactivated, is refused
 * with a plain message.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PERMISSIONS } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('assignable users for Reassign', () => {
  let t: TwoCompanies;
  let manager: Send;
  let managerId: string;
  let reportId: string;
  let accountsId: string;
  let inactiveId: string;
  let adminId: string;
  let leadId: string;

  beforeAll(async () => {
    t = await setupTwoCompanies(`assign${Date.now()}`);
    const m = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.PRESALES_INQUIRY_ASSIGN], `mgr-${t.tag}`);
    manager = m.send;
    managerId = m.userId;
    reportId = (await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId, [PERMISSIONS.PRESALES_INQUIRY_READ], `rep-${t.tag}`, { managerId })).userId;
    accountsId = (await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.POSTSALES_RECEIPT_CREATE], `acct-${t.tag}`, { managerId })).userId;
    inactiveId = (await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId, [PERMISSIONS.PRESALES_INQUIRY_READ], `gone-${t.tag}`, { managerId })).userId;
    await t.systemPrisma.user.update({ where: { id: inactiveId }, data: { isActive: false } });
    adminId = (await t.systemPrisma.user.findFirst({ where: { email: `e2e-tenant-${t.tag}@test.com` } })).id;
    const lead = await t.send('post', '/inquiries', { applicant: { name: 'Assign Lead', primaryPhone: `89${String(Date.now()).slice(-8)}` } });
    leadId = lead.body.id;
    expect((await t.send('patch', `/inquiries/${leadId}/assign`, { toUserId: reportId, reason: 'setup' })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  const ids = async (send: Send) => {
    const res = await send('get', `/inquiries/${leadId}/assignable-users`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ id: string }>).map((u) => u.id).sort();
  };

  it('a manager is offered themself and their reports who can open leads: not accounts, not a deactivated user, not outside the team', async () => {
    expect(await ids(manager)).toEqual([managerId, reportId].sort());
  });

  it('an admin is offered every active user who can open leads, and nobody from another company', async () => {
    const list = await ids(t.send);
    expect(list).toEqual(expect.arrayContaining([managerId, reportId, adminId]));
    expect(list).not.toContain(accountsId);
    expect(list).not.toContain(inactiveId);
    expect(list).not.toContain(t.B.user);
  });

  it('assigning to a user who cannot open leads, or a deactivated one, is refused (400) with a plain message', async () => {
    const toAccounts = await t.send('patch', `/inquiries/${leadId}/assign`, { toUserId: accountsId, reason: 'x' });
    expect(toAccounts.status).toBe(400);
    expect(String(toAccounts.body.message)).toMatch(/can't open leads/);
    expect((await t.send('patch', `/inquiries/${leadId}/assign`, { toUserId: inactiveId, reason: 'x' })).status).toBe(400);
    expect((await t.systemPrisma.inquiry.findUnique({ where: { id: leadId } })).assignedToId).toBe(reportId);
  });

  it('a lead outside the caller\'s team is 404, and the list needs the assign permission (403)', async () => {
    const other = await t.send('post', '/inquiries', { applicant: { name: 'Admin Lead', primaryPhone: `88${String(Date.now()).slice(-8)}` } });
    expect((await manager('get', `/inquiries/${other.body.id}/assignable-users`)).status).toBe(404);
    const { send: reader } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_INQUIRY_READ, PERMISSIONS.ADMIN_TEAM_SCOPE_ALL], `reader-${t.tag}`);
    expect((await reader('get', `/inquiries/${leadId}/assignable-users`)).status).toBe(403);
  });
});
