/**
 * The booking-wizard "no plan" defect, through the wire. The wizard used to
 * collect installments against the total EXCLUDING GST and create the
 * booking before its plan: a refused plan left a booking with no plan, the
 * unit held and every retry on the unit refused.
 *
 * The first version of this test asserted that defect against the two-step
 * requests and passed; it failed as soon as `bookLikeTheWizard` sent what
 * the wizard sends now (one POST /bookings/with-plan). It now asserts the
 * fixed behaviour: refused with the reason, nothing booked, the unit free,
 * and a retry with the GST-inclusive total succeeds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { PERMISSIONS } from '@openestate/shared';
import { makeClients, seedCompany, cleanupCompany, makeUnit, makeApplicant, type CompanyFixture } from './helpers/postsales-harness';
import { bootstrapApp, makeStaff, login, bookLikeTheWizard, type Session } from './helpers/booking-e2e';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('booking wizard: installments that add up to the pre-GST price', () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let s: Session;
  let gst5: string;

  beforeAll(async () => {
    app = await bootstrapApp();
    ({ systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    gst5 = (await systemPrisma.gstRate.create({
      data: { companyId: fx.companyId, rate: 5, description: 'GST 5%', effectiveFrom: new Date('2019-04-01') },
    })).id;
    const email = await makeStaff(systemPrisma, fx.companyId, [
      PERMISSIONS.POSTSALES_BOOKING_CREATE,
      PERMISSIONS.POSTSALES_PLAN_EDIT,
    ]);
    s = await login(app, email);
  });

  afterAll(async () => {
    await app?.close();
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
  });

  it('is refused with the reason, books nothing, and a retry with the GST-inclusive total succeeds', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const primaryApplicantId = await makeApplicant(systemPrisma, fx.companyId);
    const input = {
      unitId,
      primaryApplicantId,
      bookingDate: '2026-06-15',
      basePricePaise: 10_00_000_00n,
      gstRateId: gst5,
      // What the wizard used to show and collect: the total EXCLUDING GST.
      installments: [
        { label: 'Booking amount', dueDate: '2026-06-15', amountPaise: 2_00_000_00n },
        { label: 'On possession', dueDate: '2027-06-15', amountPaise: 8_00_000_00n },
      ],
    };

    const first = await bookLikeTheWizard(s, input);
    expect(first.status).toBe(400);
    expect(first.body.message).toContain('the GST-inclusive total is ₹10,50,000.00');
    expect(await systemPrisma.booking.count({ where: { unitId } })).toBe(0);
    expect((await systemPrisma.unit.findUnique({ where: { id: unitId } })).status).toBe('AVAILABLE');

    const retry = await bookLikeTheWizard(s, {
      ...input,
      installments: [{ label: 'Full', dueDate: '2026-06-15', amountPaise: 10_50_000_00n }],
    });
    expect(retry.status).toBe(201);
    const booking = await systemPrisma.booking.findUnique({ where: { id: retry.body.id }, include: { paymentPlans: true } });
    expect(booking.paymentPlans).toHaveLength(1);
    expect((await systemPrisma.unit.findUnique({ where: { id: unitId } })).status).toBe('BOOKED');
  });
});
