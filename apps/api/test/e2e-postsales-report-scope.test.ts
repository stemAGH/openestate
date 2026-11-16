/**
 * QA-009: post-sales reports were scoped to bookings the caller (or their
 * team) created, so accounts, which creates no bookings, saw every report
 * empty. reports.postsales.company-wide makes them company-wide; a caller
 * without it keeps the team view, and nobody ever sees another company.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PERMISSIONS, SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { sessionWith, type Send } from './helpers/role-session';
import { makeClients, buildServices, makeUnit } from './helpers/postsales-harness';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
// A string, not PERMISSIONS.X, so this file compiles before the key exists.
const COMPANY_WIDE = 'reports.postsales.company-wide';
const REPORT_READ = [
  PERMISSIONS.REPORTS_OUTSTANDING_VIEW,
  PERMISSIONS.REPORTS_COLLECTION_VIEW,
  PERMISSIONS.REPORTS_APPLICANT_LEDGER_VIEW,
];
const LIST_REPORTS = [
  '/reports/postsales/installment-dues',
  '/reports/postsales/installment-dues-with-interest',
  '/reports/postsales/collection/detail',
];

describeIf('post-sales reports: reports.postsales.company-wide', () => {
  let t: TwoCompanies;
  let wide: Send;
  let team: Send;
  let bookingNumber: string;
  let otherCompanyApplicant: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;

  beforeAll(async () => {
    t = await setupTwoCompanies(`rscope${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    // Company A's booking (made by A's admin) gets a receipt, so collections have a row.
    bookingNumber = (await t.systemPrisma.booking.findUniqueOrThrow({ where: { id: t.own.booking } })).bookingNumber;
    const inst = await t.systemPrisma.installment.findUniqueOrThrow({ where: { id: t.own.installment } });
    const receipt = await t.send('post', '/receipts', {
      bookingId: t.own.booking, receiptDate: '2026-11-12', mode: 'NEFT', grossAmountPaise: '1000',
      allocations: [{ installmentId: inst.id, amountPaise: '1000' }],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);

    // Company B's booking, with a plan and a receipt, which no one in A may ever
    // see. Booking numbers are per company (B's is the same as A's), so B's
    // rows are told apart by the applicant's name.
    const svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    const b = await svc.bookings.createBooking(
      t.B.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.B.fx), primaryApplicantId: t.B.applicant, coApplicantIds: [], bookingDate: new Date('2026-06-01'),
        costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 100000n, gstRateId: t.B.fx.defaultGstRateId }],
      },
      t.B.fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      t.B.fx.companyId, b.id,
      { name: 'P', isCustom: true, installments: [{ label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: b.agreedPricePaise }] },
      t.B.fx.userId,
    );
    await svc.receipts.createReceipt(
      t.B.fx.companyId,
      { bookingId: b.id, receiptDate: new Date('2026-11-12'), mode: 'NEFT', grossAmountPaise: 500n,
        allocations: [{ installmentId: plan.installments[0].id, amountPaise: 500n }], tdsDeductedPaise: 0n },
      t.B.fx.userId,
    );
    otherCompanyApplicant = JSON.stringify((await t.systemPrisma.applicant.findUniqueOrThrow({ where: { id: t.B.applicant } })).name);

    ({ send: wide } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId, [...REPORT_READ, COMPANY_WIDE], `wide-${t.tag}`));
    ({ send: team } = await sessionWith(t.app, t.systemPrisma, t.A.fx.companyId, REPORT_READ, `team-${t.tag}`));
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  const body = async (send: Send, url: string) => {
    const res = await send('get', url);
    expect(res.status, `${url}: ${JSON.stringify(res.body)}`).toBe(200);
    return JSON.stringify(res.body);
  };

  it('with the permission, the list reports show a booking another user created', async () => {
    for (const url of LIST_REPORTS) expect(await body(wide, url), url).toContain(bookingNumber);
  });

  it('with the permission, collection totals and the applicant ledger include it', async () => {
    const summary = JSON.parse(await body(wide, '/reports/postsales/collection/summary'));
    expect(Number(summary.totalReceipts)).toBeGreaterThanOrEqual(1);
    expect(await body(wide, '/reports/postsales/collection/daily')).toContain('2026-11-12');
    expect(await body(wide, '/reports/postsales/collection/monthly')).toContain('2026-11');
    const ledger = await wide('get', `/reports/postsales/applicant-ledger/${t.own.booking}`);
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
  });

  it('without it, a caller keeps the team view: none of another user’s bookings', async () => {
    for (const url of LIST_REPORTS) expect(await body(team, url), url).not.toContain(bookingNumber);
    const summary = JSON.parse(await body(team, '/reports/postsales/collection/summary'));
    expect(Number(summary.totalReceipts)).toBe(0);
    expect((await team('get', `/reports/postsales/applicant-ledger/${t.own.booking}`)).status).toBe(404);
  });

  it("with it, another company's bookings never appear", async () => {
    for (const url of LIST_REPORTS) expect(await body(wide, url), url).not.toContain(otherCompanyApplicant);
    // A's only receipt: B's (₹5.00, dated the same day) is not counted.
    const summary = JSON.parse(await body(wide, '/reports/postsales/collection/summary'));
    expect(Number(summary.totalReceipts)).toBe(1);
    expect(summary.totalCollectedFormatted).toBe('₹10.00');
  });
});
