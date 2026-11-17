/**
 * The bookings list (v0.10.1, Plan C): GET /bookings with strict filters, the
 * outstanding balance from the ledger, masked phones. Sales roles see their
 * team's bookings (created by them or their reports); a caller with
 * admin.team-scope.all or reports.postsales.company-wide sees the company;
 * nobody sees another company.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';
import { makeClients, buildServices, makeUnit, makeApplicant } from './helpers/postsales-harness';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
type Row = { id: string; bookingNumber: string; status: string; balancePaise: string; applicant: { name: string; primaryPhone: string } };

describeIf('GET /bookings', () => {
  let t: TwoCompanies;
  let exec: Send;
  let accounts: Send;
  let none: Send;
  let execBooking: { id: string; bookingNumber: string; phone: string };
  let adminBooking: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;

  beforeAll(async () => {
    t = await setupTwoCompanies(`bklist${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    const e = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId, [PERMISSIONS.POSTSALES_BOOKING_READ], `exec-${t.tag}`);
    exec = e.send;
    ({ send: accounts } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId,
      [PERMISSIONS.POSTSALES_BOOKING_READ, PERMISSIONS.REPORTS_POSTSALES_COMPANY_WIDE], `acct-${t.tag}`));
    ({ send: none } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId, [PERMISSIONS.PRESALES_INQUIRY_READ], `none-${t.tag}`));
    const applicantId = await makeApplicant(t.systemPrisma, t.A.fx.companyId);
    const b = await svc.bookings.createBooking(
      t.A.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.A.fx), primaryApplicantId: applicantId, coApplicantIds: [], bookingDate: new Date('2026-05-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 200000n, gstRateId: t.A.fx.defaultGstRateId }],
      },
      e.userId,
    );
    execBooking = { id: b.id, bookingNumber: b.bookingNumber, phone: (await t.systemPrisma.applicant.findUnique({ where: { id: applicantId } })).primaryPhone };
    adminBooking = t.own.booking;
    // Company B's booking, never listed for A.
    await svc.bookings.createBooking(
      t.B.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.B.fx), primaryApplicantId: t.B.applicant, coApplicantIds: [], bookingDate: new Date('2026-05-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: t.B.fx.defaultGstRateId }],
      },
      t.B.fx.userId,
    );
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  const list = async (send: Send, qs = '') => {
    const res = await send('get', `/bookings${qs}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { data: Row[]; meta: { total: number } };
  };

  it('a sales user sees only the bookings their team created', async () => {
    const ids = (await list(exec)).data.map((r) => r.id);
    expect(ids).toContain(execBooking.id);
    expect(ids).not.toContain(adminBooking);
  });

  it('accounts (company-wide report permission) and admins see every booking of the company, none of another', async () => {
    for (const send of [accounts, t.send]) {
      const body = await list(send, '?limit=100');
      const ids = body.data.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([execBooking.id, adminBooking]));
      const companyCount = await t.systemPrisma.booking.count({ where: { companyId: t.A.fx.companyId } });
      expect(body.meta.total).toBe(companyCount);
    }
  });

  it('each row carries the ledger balance and a masked phone', async () => {
    const body = await list(t.send, '?limit=100');
    for (const r of body.data) {
      expect(BigInt(r.balancePaise), r.bookingNumber).toBe(await svc.ledger.balance(t.A.fx.companyId, r.id));
    }
    expect(JSON.stringify(body)).not.toContain(execBooking.phone);
  });

  it('filters by booking number, phone in any format, status and booking date', async () => {
    expect((await list(t.send, `?search=${encodeURIComponent(execBooking.bookingNumber)}`)).data.map((r) => r.id)).toContain(execBooking.id);
    const spaced = `+91 ${execBooking.phone.slice(0, 5)} ${execBooking.phone.slice(5)}`;
    expect((await list(t.send, `?search=${encodeURIComponent(spaced)}`)).data.map((r) => r.id)).toEqual([execBooking.id]);
    expect((await list(t.send, '?status=CANCELLED')).data).toHaveLength(0);
    const may = (await list(t.send, '?from=2026-05-01&to=2026-05-31')).data.map((r) => r.id);
    expect(may).toContain(execBooking.id);
    expect(may).not.toContain(adminBooking); // booked 2026-11-12
  });

  it('refuses unknown parameters, an unknown sort and an unknown status (400), and callers without booking read (403)', async () => {
    expect((await t.send('get', '/bookings?x=1')).status).toBe(400);
    expect((await t.send('get', '/bookings?sortBy=agreedPricePaise')).status).toBe(400);
    expect((await t.send('get', '/bookings?status=LOST')).status).toBe(400);
    expect((await none('get', '/bookings')).status).toBe(403);
  });
});
