/**
 * Through-the-wire tests for POST /bookings/quote and POST /bookings/with-plan:
 * the happy paths (custom and template plans, with an interest rule), the
 * refusals (wrong total, price changed since the quote, a COMPOUND interest
 * rule refused at the LAST step), permissions, audit rows and the log line.
 * After every refusal: no booking, plan, installment, ledger, unit-status or
 * audit row survives, the unit stays AVAILABLE, the booking number is not
 * used up, and a retry on the same unit succeeds.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, makeUnit, makeApplicant, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, makeStaff, login, type Session } from './helpers/booking-e2e';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

const P = PERMISSIONS;
const BASE = 10_00_000_00n; // ₹10,00,000
const TOTAL = 10_50_000_00n; // with 5% GST

describeIf('POST /bookings/quote and POST /bookings/with-plan', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let gst5: string;
  let simpleRule: string;
  let compoundRule: string;
  let templateId: string;
  const s: Record<'full' | 'noInterest' | 'createOnly' | 'planOnly', Session> = {} as never;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    gst5 = (await systemPrisma.gstRate.create({
      data: { companyId: fx.companyId, rate: 5, description: 'GST 5%', effectiveFrom: new Date('2019-04-01') },
    })).id;
    simpleRule = (await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: 'Simple 12%', rateType: 'SIMPLE', ratePercent: 12, frequency: 'YEARLY' },
    })).id;
    compoundRule = (await systemPrisma.interestRule.create({
      data: { companyId: fx.companyId, name: 'Compound 12%', rateType: 'COMPOUND', ratePercent: 12, frequency: 'MONTHLY' },
    })).id;
    const template = await systemPrisma.paymentPlanTemplate.create({ data: { companyId: fx.companyId, name: '20/80' } });
    templateId = template.id;
    await systemPrisma.paymentPlanMilestone.createMany({
      data: [
        { companyId: fx.companyId, templateId, seq: 1, label: 'Booking', percent: 20, dueOffsetDays: 0 },
        { companyId: fx.companyId, templateId, seq: 2, label: 'Possession', percent: 80, dueOffsetDays: 365 },
      ],
    });
    const users = {
      full: [P.POSTSALES_BOOKING_CREATE, P.POSTSALES_PLAN_EDIT, P.POSTSALES_INTEREST_MANAGE],
      noInterest: [P.POSTSALES_BOOKING_CREATE, P.POSTSALES_PLAN_EDIT],
      createOnly: [P.POSTSALES_BOOKING_CREATE],
      planOnly: [P.POSTSALES_PLAN_EDIT],
    } as const;
    for (const [name, keys] of Object.entries(users)) {
      const email = await makeStaff(systemPrisma, fx.companyId, [...keys]);
      ids[name] = (await systemPrisma.user.findFirst({ where: { companyId: fx.companyId, email } })).id;
      s[name as keyof typeof s] = await login(app, email);
    }
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  const costLines = () => [{ kind: 'BASE', label: 'Base Sale Price', baseAmountPaise: BASE.toString(), gstRateId: gst5 }];
  const bookingDate = new Date().toISOString().slice(0, 10);

  async function body(unitId: string, extra: Record<string, unknown> = {}) {
    return {
      unitId,
      primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId),
      coApplicantIds: [],
      bookingDate,
      costLines: costLines(),
      plan: {
        mode: 'custom',
        installments: [
          { label: 'Booking amount', dueDate: bookingDate, amountPaise: (2_10_000_00n).toString() },
          { label: 'On possession', dueDate: '2030-01-01', amountPaise: (8_40_000_00n).toString() },
        ],
      },
      ...extra,
    };
  }
  const post = (who: keyof typeof s, path: string, payload: unknown) =>
    s[who].agent.post(`/api/v1/bookings/${path}`).set(s[who].auth).send(payload);

  const nextBookingNumber = async () =>
    (await systemPrisma.numberSequence.findMany({ where: { companyId: fx.companyId, kind: 'BOOKING' } }))
      .map((r: { scopeLabel: string; nextValue: bigint | number }) => `${r.scopeLabel}:${r.nextValue}`)
      .sort()
      .join(',');
  const auditCount = () => systemPrisma.auditLog.count({ where: { companyId: fx.companyId } });

  /** Nothing about a refused booking of `unitId` survives. */
  async function expectNothingWritten(unitId: string, before: { audit: number; seq: string }) {
    expect(await systemPrisma.booking.count({ where: { unitId } })).toBe(0);
    expect(await systemPrisma.paymentPlan.count({ where: { booking: { unitId } } })).toBe(0);
    expect(await systemPrisma.installment.count({ where: { booking: { unitId } } })).toBe(0);
    expect(await systemPrisma.ledgerEntry.count({ where: { booking: { unitId } } })).toBe(0);
    expect(await systemPrisma.unitStatusChange.count({ where: { unitId } })).toBe(0);
    expect((await systemPrisma.unit.findUnique({ where: { id: unitId } })).status).toBe('AVAILABLE');
    expect(await auditCount()).toBe(before.audit);
    expect(await nextBookingNumber()).toBe(before.seq);
  }
  const snapshot = async () => ({ audit: await auditCount(), seq: await nextBookingNumber() });

  it('quote: lines with GST and the GST-inclusive total, nothing written', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const before = await snapshot();
    const res = await post('createOnly', 'quote', { unitId, costLines: costLines() }).expect(201);
    expect(res.body).toMatchObject({
      unitStatus: 'AVAILABLE',
      totalBeforeGstPaise: BASE.toString(),
      gstPaise: (TOTAL - BASE).toString(),
      agreedPricePaise: TOTAL.toString(),
      placeOfSupplyStateCode: '09',
    });
    expect(res.body.costLines[0]).toMatchObject({ cgstPaise: '2500000', sgstPaise: '2500000', igstPaise: '0' });
    await expectNothingWritten(unitId, before);
  });

  it('happy path, custom plan: booking, plan, ledger, unit and audit rows in one request', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const quote = await post('full', 'quote', { unitId, costLines: costLines() }).expect(201);
    const res = await post('full', 'with-plan', await body(unitId, { expectedAgreedPricePaise: quote.body.agreedPricePaise })).expect(201);
    const bookingId = res.body.booking.id;
    const booking = await systemPrisma.booking.findUnique({
      where: { id: bookingId },
      include: { paymentPlans: { include: { installments: true } } },
    });
    expect(booking.status).toBe('BOOKED');
    expect(booking.agreedPricePaise).toBe(TOTAL);
    expect(booking.paymentPlans).toHaveLength(1);
    expect(booking.paymentPlans[0].installments.reduce((t: bigint, i: { amountPaise: bigint }) => t + i.amountPaise, 0n)).toBe(TOTAL);
    expect(await systemPrisma.ledgerEntry.count({ where: { bookingId } })).toBe(1);
    expect((await systemPrisma.unit.findUnique({ where: { id: unitId } })).status).toBe('BOOKED');
    const audit = await systemPrisma.auditLog.findMany({
      where: { companyId: fx.companyId, OR: [{ entityId: bookingId }, { entityId: unitId }, { entityType: 'PaymentPlan', entityId: booking.paymentPlans[0].id }] },
    });
    const kinds = audit.map((a: { entityType: string; action: string }) => `${a.entityType}:${a.action}`);
    expect(kinds).toEqual(expect.arrayContaining(['Booking:CREATE', 'PaymentPlan:CREATE', 'Unit:UPDATE']));
    for (const a of audit) expect(a.userId).toBe(ids.full);
  });

  it('happy path, template plan', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const res = await post('full', 'with-plan', await body(unitId, { plan: { mode: 'template', templateId } })).expect(201);
    const plan = await systemPrisma.paymentPlan.findFirst({ where: { bookingId: res.body.booking.id }, include: { installments: true } });
    expect(plan.templateId).toBe(templateId);
    expect(plan.installments.map((i: { amountPaise: bigint }) => i.amountPaise).sort()).toEqual([2_10_000_00n, 8_40_000_00n]);
  });

  it('wrong total: 400 with the reason, logged; nothing written; unit free; a retry succeeds', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const before = await snapshot();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const res = await post('full', 'with-plan', await body(unitId, {
      plan: {
        mode: 'custom',
        installments: [
          { label: 'Booking amount', dueDate: bookingDate, amountPaise: (2_00_000_00n).toString() },
          { label: 'On possession', dueDate: '2030-01-01', amountPaise: (8_00_000_00n).toString() },
        ],
      },
    })).expect(400);
    const reason =
      'Payment plan refused: the installments add up to ₹10,00,000.00 but the GST-inclusive total is ₹10,50,000.00.';
    expect(res.body.message).toContain(reason);
    expect(warn.mock.calls.some(([m]) => String(m).includes(reason) && String(m).includes(unitId))).toBe(true);
    warn.mockRestore();
    await expectNothingWritten(unitId, before);
    await post('full', 'with-plan', await body(unitId)).expect(201);
  });

  it('price changed between quote and booking: 409, nothing written', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const quote = await post('full', 'quote', { unitId, costLines: costLines() }).expect(201);
    await systemPrisma.gstRate.update({ where: { id: gst5 }, data: { rate: 12 } });
    try {
      const before = await snapshot();
      const res = await post('full', 'with-plan', await body(unitId, { expectedAgreedPricePaise: quote.body.agreedPricePaise })).expect(409);
      expect(res.body.message).toContain('The price changed since the quote: quoted ₹10,50,000.00, now ₹11,20,000.00');
      await expectNothingWritten(unitId, before);
    } finally {
      await systemPrisma.gstRate.update({ where: { id: gst5 }, data: { rate: 5 } });
    }
  });

  it('interest rule inside the call: attached and audited', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const res = await post('full', 'with-plan', await body(unitId, { interestRuleId: simpleRule })).expect(201);
    const booking = await systemPrisma.booking.findUnique({ where: { id: res.body.booking.id } });
    expect(booking.interestRuleId).toBe(simpleRule);
    const row = await systemPrisma.auditLog.findFirst({ where: { entityId: booking.id, action: 'INTEREST_RULE_SET' } });
    expect(row?.userId).toBe(ids.full);
  });

  it('late failure: a COMPOUND rule refused after the booking and plan exist in the transaction rolls back everything', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const before = await snapshot();
    const res = await post('full', 'with-plan', await body(unitId, { interestRuleId: compoundRule })).expect(409);
    expect(res.body.message).toContain('Only simple-interest rules can be attached');
    await expectNothingWritten(unitId, before);
    // The number is not used up: the retry takes exactly the number the refused attempt had.
    const retry = await post('full', 'with-plan', await body(unitId, { interestRuleId: simpleRule })).expect(201);
    const [scope, next] = before.seq.split(',').find((x) => x.length)?.split(':') ?? [];
    if (scope) expect(retry.body.booking.bookingNumber).toBe(`BKG/${scope}/${String(next).padStart(6, '0')}`);
  });

  it('permissions: exactly booking.create + plan.edit, and interest.manage only with interestRuleId', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const before = await snapshot();
    await post('createOnly', 'with-plan', await body(unitId)).expect(403);
    await post('planOnly', 'with-plan', await body(unitId)).expect(403);
    await post('planOnly', 'quote', { unitId, costLines: costLines() }).expect(403);
    await post('noInterest', 'with-plan', await body(unitId, { interestRuleId: simpleRule })).expect(403);
    await expectNothingWritten(unitId, before);
    await post('noInterest', 'with-plan', await body(unitId)).expect(201);
  });

  it('refuses unknown fields', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    await post('full', 'with-plan', await body(unitId, { paymentPlanTemplateId: templateId })).expect(400);
  });
});
