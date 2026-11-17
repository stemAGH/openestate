/**
 * Editing an applicant's contact details (v0.10.1, Plan B): PATCH
 * /applicants/:id with name, phone, email and address.
 *
 * - A phone or email that matches another person is refused (409) with the
 *   matches listed; the caller can confirm they are different people
 *   (recorded, as on creation). No merge from here.
 * - When the customer has a portal account that signs in with the phone or
 *   email being changed: the change needs admin.user.update, the portal
 *   login follows the new value, that account's sessions end, and an audit
 *   row records it with masked values.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PERMISSIONS } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';
import { makePortalRole } from './helpers/postsales-harness';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
let seq = 0;
const phone = () => `8${String(Date.now()).slice(-7)}${String(seq++).padStart(2, '0')}`;

describeIf('editing an applicant', () => {
  let t: TwoCompanies;
  let sales: Send;
  let portalRoleId: string;

  async function applicant(extra: Record<string, unknown> = {}) {
    const p = phone();
    const a = await t.systemPrisma.applicant.create({
      data: { companyId: t.A.fx.companyId, name: `Person ${seq}-${Date.now()}`, primaryPhone: p, primaryPhoneNormalized: p, ...extra },
    });
    return { id: a.id as string, phone: p };
  }

  async function portalAccount(applicantId: string, login: { email?: string; phone?: string }) {
    return t.systemPrisma.user.create({
      data: {
        companyId: t.A.fx.companyId, name: 'Portal customer', passwordHash: 'x', roleId: portalRoleId, applicantId,
        email: login.email ?? null, phone: login.phone ?? null, forcePasswordChange: false,
        refreshTokens: { create: [{ tokenHash: `h${Date.now()}${seq++}`.padEnd(64, '0'), family: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) }] },
      },
    });
  }

  beforeAll(async () => {
    t = await setupTwoCompanies(`appedit${Date.now()}`);
    portalRoleId = await makePortalRole(t.systemPrisma, t.A.fx.companyId, 'customer');
    ({ send: sales } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.PRESALES_APPLICANT_READ, PERMISSIONS.PRESALES_APPLICANT_UPDATE], `sales-${t.tag}`));
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it('edits name, phone, email and address; the new phone is searchable in any format', async () => {
    const a = await applicant();
    const p = phone();
    const res = await sales('patch', `/applicants/${a.id}`, {
      name: 'Renamed Person', primaryPhone: `+91 ${p.slice(0, 5)} ${p.slice(5)}`, email: `r${seq}@example.com`, addressLine1: '1 Main Road', city: 'Pune',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await t.systemPrisma.applicant.findUnique({ where: { id: a.id } });
    expect(stored).toMatchObject({ name: 'Renamed Person', primaryPhoneNormalized: p, city: 'Pune' });
    const found = await sales('get', `/applicants?search=${p.slice(-6)}`);
    expect(found.body.data.map((x: { id: string }) => x.id)).toContain(a.id);
  });

  it("a phone that matches another person is refused with the matches; confirming they're different saves it", async () => {
    const a = await applicant();
    const other = await applicant();
    const res = await sales('patch', `/applicants/${a.id}`, { primaryPhone: other.phone });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.duplicates.map((d: { id: string }) => d.id)).toContain(other.id);
    expect(JSON.stringify(res.body)).not.toContain(other.phone);
    expect((await t.systemPrisma.applicant.findUnique({ where: { id: a.id } })).primaryPhone).toBe(a.phone);

    const ok = await sales('patch', `/applicants/${a.id}`, { primaryPhone: other.phone, confirmDistinct: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await t.systemPrisma.applicantDistinctPair.count({ where: { OR: [{ applicantAId: a.id, applicantBId: other.id }, { applicantAId: other.id, applicantBId: a.id }] } })).toBe(1);
  });

  it("changing the phone a portal customer signs in with needs admin.user.update; other fields don't", async () => {
    const a = await applicant();
    await portalAccount(a.id, { phone: a.phone });
    expect((await sales('patch', `/applicants/${a.id}`, { primaryPhone: phone() })).status).toBe(403);
    expect((await sales('patch', `/applicants/${a.id}`, { name: 'Still Fine' })).status).toBe(200);
  });

  it('an admin change to the sign-in phone moves the portal login, ends its sessions and is audited with masked values', async () => {
    const a = await applicant();
    const user = await portalAccount(a.id, { phone: a.phone });
    const p = phone();
    const res = await t.send('patch', `/applicants/${a.id}`, { primaryPhone: p });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await t.systemPrisma.user.findUnique({ where: { id: user.id } });
    expect(after.phone).toBe(p);
    expect(after.authzVersion).toBe(user.authzVersion + 1);
    expect(await t.systemPrisma.refreshToken.count({ where: { userId: user.id, isRevoked: false } })).toBe(0);
    const audit = await t.systemPrisma.auditLog.findFirst({ where: { entityId: user.id, action: 'PORTAL_LOGIN_CHANGED' } });
    expect(audit).not.toBeNull();
    expect(audit.after).toMatchObject({ applicantId: a.id, field: 'phone' });
    expect(JSON.stringify(audit)).not.toContain(p);
    expect(JSON.stringify(audit)).not.toContain(a.phone);
  });

  it('the sign-in email moves too, and an email another account already signs in with is refused (409)', async () => {
    const a = await applicant({ email: `old${seq}@example.com`, emailNormalized: `old${seq}@example.com` });
    const stored = await t.systemPrisma.applicant.findUnique({ where: { id: a.id } });
    const user = await portalAccount(a.id, { email: stored.email });
    const taken = await t.systemPrisma.user.create({
      data: { companyId: t.A.fx.companyId, name: 'Other account', email: `taken${seq++}@example.com`, passwordHash: 'x', roleId: (await t.systemPrisma.user.findUniqueOrThrow({ where: { id: t.A.fx.userId } })).roleId },
    });
    const clash = await t.send('patch', `/applicants/${a.id}`, { email: taken.email, confirmDistinct: true });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    const fresh = `new${seq++}@example.com`;
    const res = await t.send('patch', `/applicants/${a.id}`, { email: fresh });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await t.systemPrisma.user.findUnique({ where: { id: user.id } })).email).toBe(fresh);
  });

  it("refuses unknown fields (400) and another company's applicant (404)", async () => {
    const a = await applicant();
    expect((await sales('patch', `/applicants/${a.id}`, { name: 'x', nickname: 'y' })).status).toBe(400);
    expect((await sales('patch', `/applicants/${t.B.applicant}`, { name: 'x' })).status).toBe(404);
  });
});
