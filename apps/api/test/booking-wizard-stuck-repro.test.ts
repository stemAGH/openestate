/**
 * Reproduction of the booking-wizard "no plan" defect, through the wire.
 * The wizard's custom-plan step collects installments against the total
 * EXCLUDING GST, but the server requires them to add up to the GST-inclusive
 * agreed price, and the wizard creates the booking before the plan.
 *
 * This test asserts the defect as it stands: the plan is refused, the
 * booking is left BOOKED with no plan, the unit stays BOOKED and a retry on
 * the unit is refused. It must fail once the wizard books atomically.
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

  it('leaves a booking with no plan, the unit held, and a retry refused', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const primaryApplicantId = await makeApplicant(systemPrisma, fx.companyId);
    const input = {
      unitId,
      primaryApplicantId,
      bookingDate: '2026-06-15',
      basePricePaise: 10_00_000_00n,
      gstRateId: gst5,
      // What the wizard shows and collects: the total EXCLUDING GST.
      installments: [
        { label: 'Booking amount', dueDate: '2026-06-15', amountPaise: 2_00_000_00n },
        { label: 'On possession', dueDate: '2027-06-15', amountPaise: 8_00_000_00n },
      ],
    };

    const first = await bookLikeTheWizard(s, input);
    expect(first.status).toBe(400);
    expect(first.body.message).toContain('must sum to the amount to schedule');

    const bookings = await systemPrisma.booking.findMany({ where: { unitId }, include: { paymentPlans: true } });
    expect(bookings).toHaveLength(1);
    expect(bookings[0].status).toBe('BOOKED');
    expect(bookings[0].paymentPlans).toHaveLength(0);
    expect(bookings[0].agreedPricePaise).toBe(10_50_000_00n);
    expect((await systemPrisma.unit.findUnique({ where: { id: unitId } })).status).toBe('BOOKED');

    const retry = await bookLikeTheWizard(s, {
      ...input,
      installments: [{ label: 'Full', dueDate: '2026-06-15', amountPaise: 10_50_000_00n }],
    });
    expect(retry.status).toBe(400);
    expect(retry.body.message).toContain('only AVAILABLE or HELD units can be booked');
  });
});
