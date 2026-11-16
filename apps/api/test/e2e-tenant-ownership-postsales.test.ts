/**
 * The same rule as e2e-tenant-ownership.test.ts, for the post-sales
 * services: a booking cost line's charge type, co-applicants, a receipt's
 * bank and receipt type, and the bank a refund or a broker commission is
 * paid from must all be the caller's company's own. Nothing is priced,
 * booked, received or paid when one isn't.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeUnit } from './helpers/postsales-harness';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const TAG = `${Date.now()}-${process.pid}`;
process.env.THROTTLE_TEST_KEY_PREFIX = `e2e-tenant-ownership-postsales-${TAG}-`;

describeIf('e2e tenant ownership in the post-sales services', () => {
  let t: TwoCompanies;
  beforeAll(async () => { t = await setupTwoCompanies(TAG); }, 180_000);
  afterAll(async () => { await t?.cleanup(); });

  it('bookings: a cost line’s charge type and a co-applicant must be the company’s own', async () => {
    const { A, B, send, refused, systemPrisma } = t;
    const unit = await makeUnit(systemPrisma, A.fx);
    const costLines = [
      { kind: 'BASE', label: 'Base', baseAmountPaise: '100000', gstRateId: A.fx.defaultGstRateId },
      { kind: 'OTHER', label: 'Club', chargeTypeId: B.chargeType, baseAmountPaise: '100', gstRateId: A.fx.defaultGstRateId },
    ];
    refused(await send('post', '/bookings/quote', { unitId: unit, costLines }), /charge type .*not found/i);
    const base = [costLines[0]];
    const quote = await send('post', '/bookings/quote', { unitId: unit, costLines: base });
    // Booking with that cost line is refused too (not only the quote).
    refused(await send('post', '/bookings/with-plan', {
      unitId: unit, primaryApplicantId: A.applicant, coApplicantIds: [], bookingDate: '2026-11-12', costLines,
      expectedAgreedPricePaise: quote.body.agreedPricePaise,
      plan: { mode: 'custom', name: 'Custom Plan', installments: [{ label: 'All', dueDate: '2026-12-01', amountPaise: quote.body.agreedPricePaise }] },
    }), /charge type .*not found/i);
    refused(await send('post', '/bookings/with-plan', {
      unitId: unit, primaryApplicantId: A.applicant, coApplicantIds: [B.applicant], bookingDate: '2026-11-12', costLines: base,
      expectedAgreedPricePaise: quote.body.agreedPricePaise,
      plan: { mode: 'custom', name: 'Custom Plan', installments: [{ label: 'All', dueDate: '2026-12-01', amountPaise: quote.body.agreedPricePaise }] },
    }), /co-applicant not found/i);
    expect((await systemPrisma.unit.findUnique({ where: { id: unit } })).status, 'unit stays free').toBe('AVAILABLE');
  });

  it('receipts: the bank and receipt type must be the company’s own', async () => {
    const { A, B, send, refused, own } = t;
    const body = (extra: object) => ({ bookingId: own.booking, receiptDate: '2026-11-12', grossAmountPaise: '100', allocations: [{ installmentId: own.installment, amountPaise: '100' }], ...extra });
    refused(await send('post', '/receipts', body({ mode: 'CHEQUE', bankId: B.bank, instrumentNumber: '000123', instrumentDate: '2026-11-12' })), /bank not found/i);
    refused(await send('post', '/receipts', body({ mode: 'NEFT', utr: 'XTUTR1', receiptTypeId: B.receiptType })), /receipt type not found/i);
    const ok = await send('post', '/receipts', body({ mode: 'CHEQUE', bankId: A.bank, receiptTypeId: A.receiptType, instrumentNumber: '000124', instrumentDate: '2026-11-12' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('paying a refund or a broker commission: the bank must be the company’s own', async () => {
    const { A, B, send, refused, own, systemPrisma } = t;
    const refund = await systemPrisma.refund.create({ data: { companyId: A.fx.companyId, bookingId: own.booking, amountPaise: 100n, status: 'APPROVED' } });
    refused(await send('post', `/refunds/${refund.id}/pay`, { mode: 'CHEQUE', bankId: B.bank, instrumentNumber: '000777', instrumentDate: '2026-11-12' }), /bank not found/i);
    expect((await systemPrisma.refund.findUnique({ where: { id: refund.id } })).status, 'refund not paid').toBe('APPROVED');
    const payment = await systemPrisma.commissionPayment.create({ data: { companyId: A.fx.companyId, brokerId: A.broker, amountPaise: 100n, status: 'APPROVED' } });
    refused(await send('post', `/commission-payments/${payment.id}/pay`, { mode: 'NEFT', paymentDate: '2026-11-12', bankId: B.bank }), /bank not found/i);
    expect((await systemPrisma.commissionPayment.findUnique({ where: { id: payment.id } })).status, 'commission not paid').toBe('APPROVED');
  });

  it('no row of company A points at another company’s row', async () => {
    expect(await t.crossReferencesOfA()).toEqual([]);
  });
});
