/**
 * A bounced REFUND cheque (the company's own payment) is charged from its own
 * company setting, refundChequeBounceChargePaise, default ₹0 (owner ruling
 * 2026-11-18). A bounced RECEIPT cheque (the customer's) still uses
 * chequeBounceChargePaise, unchanged. The new setting is part of
 * PATCH /company/config; existing installs read ₹0 after the migration.
 *
 * Requires DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM (and the compiled dist/
 * for the API case).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { makeClients, buildServices, seedCompany, makeUnit, makeApplicant, cleanupCompany, type Services, type CompanyFixture } from './helpers/postsales-harness';
import { setupTwoCompanies } from './helpers/two-companies';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;
const L = (rupees: number) => BigInt(rupees) * 100n;

describeIf('refund-cheque bounce charge', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;
  let ruleId: string;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma); // receipt-cheque bounce charge ₹500 (harness default)
    ruleId = (await systemPrisma.cancellationRule.create({
      data: { companyId: fx.companyId, name: '10%', deductionType: 'PERCENT', deductionPercent: 10 },
    })).id;
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  async function bookedAndPaid() {
    const b = await svc.bookings.createBooking(
      fx.companyId,
      {
        unitId: await makeUnit(systemPrisma, fx), primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: L(10_00_000), gstRateId: fx.defaultGstRateId }],
      },
      fx.userId,
    );
    const plan = await svc.plans.createCustomPlan(
      fx.companyId, b.id,
      { name: 'P', isCustom: true, installments: [{ label: 'All', dueDate: new Date('2026-06-15'), amountPaise: b.agreedPricePaise }] },
      fx.userId,
    );
    return { b, inst: plan.installments[0] };
  }

  async function bouncedRefundCharge() {
    const { b, inst } = await bookedAndPaid();
    await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: b.id, receiptDate: new Date('2026-06-16'), mode: 'NEFT', grossAmountPaise: L(10_00_000),
        allocations: [{ installmentId: inst.id, amountPaise: L(10_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.cancellations.cancel(fx.companyId, b.id, { cancellationType: 'CANCEL', cancellationRuleId: ruleId }, fx.userId);
    const r = await svc.refunds.request(fx.companyId, b.id, { amountPaise: L(9_00_000), mode: 'CHEQUE' }, fx.userId);
    await svc.refunds.approve(fx.companyId, r.id, fx.userId);
    const v = await svc.refunds.pay(fx.companyId, r.id, { mode: 'CHEQUE', instrumentNumber: 'RB1' }, fx.userId);
    await svc.refunds.voucherBounced(fx.companyId, v.id, fx.userId);
    const charges = await systemPrisma.ledgerEntry.findMany({ where: { bookingId: b.id, entryType: 'BOUNCE_CHARGE' } });
    return charges.map((c: { signedAmountPaise: bigint }) => c.signedAmountPaise);
  }

  it('by default a bounced refund cheque charges nothing, though the receipt-cheque charge is ₹500', async () => {
    expect((await systemPrisma.companyConfig.findUnique({ where: { companyId: fx.companyId } })).chequeBounceChargePaise).toBe(L(500));
    expect(await bouncedRefundCharge()).toEqual([]);
  });

  it('a refund-cheque charge, when set, is posted on a bounced refund cheque', async () => {
    await systemPrisma.companyConfig.update({ where: { companyId: fx.companyId }, data: { refundChequeBounceChargePaise: L(300) } });
    expect(await bouncedRefundCharge()).toEqual([L(300)]);
  });

  it('a bounced receipt cheque still charges the receipt-cheque setting', async () => {
    const { b, inst } = await bookedAndPaid();
    const receipt = await svc.receipts.createReceipt(
      fx.companyId,
      { bookingId: b.id, receiptDate: new Date('2026-06-16'), mode: 'CHEQUE', grossAmountPaise: L(1_00_000), instrumentNumber: 'C77',
        allocations: [{ installmentId: inst.id, amountPaise: L(1_00_000) }], tdsDeductedPaise: 0n },
      fx.userId,
    );
    await svc.receipts.recordChequeEvent(fx.companyId, receipt.id, { status: 'BOUNCED', eventDate: new Date('2026-06-20'), reason: 'insufficient funds' }, fx.userId);
    const charges = await systemPrisma.ledgerEntry.findMany({ where: { bookingId: b.id, entryType: 'BOUNCE_CHARGE' } });
    expect(charges.map((c: { signedAmountPaise: bigint }) => c.signedAmountPaise)).toEqual([L(500)]);
  });

  it('the column is NOT NULL with default 0, so existing installs read ₹0; the setting is part of PATCH /company/config', async () => {
    const [col] = await systemPrisma.$queryRaw<Array<{ column_default: string; is_nullable: string }>>`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'company_configs' AND column_name = 'refund_cheque_bounce_charge_paise'`;
    expect(col).toMatchObject({ is_nullable: 'NO' });
    expect(String(col.column_default)).toMatch(/^0/);
    const t = await setupTwoCompanies(`rbc${Date.now()}`);
    try {
      expect((await t.send('patch', '/company/config', { refundChequeBounceChargePaise: '25000' })).status).toBe(200);
      expect((await t.systemPrisma.companyConfig.findUnique({ where: { companyId: t.A.fx.companyId } })).refundChequeBounceChargePaise).toBe(25000n);
      expect((await t.send('patch', '/company/config', { refundChequeBounceChargePaise: '-1' })).status).toBe(400);
    } finally {
      await t.cleanup();
    }
  }, 120_000);
});
