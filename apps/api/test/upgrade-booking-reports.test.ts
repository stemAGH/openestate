/**
 * Upgrade-time read-only reports (printed by packages/db/prisma/sync-permissions.ts):
 *  - bookingsWithoutPlan: active bookings (BOOKED/ALLOTTED/REGISTERED) with no
 *    active payment plan, as the old two-step booking wizard could leave them;
 *  - unitsWithMultipleActiveBookings: units with more than one active booking,
 *    which nothing stopped before the unit lock.
 * Both only count; nothing is changed. Scoped to this file's company, because
 * other test files create bookings concurrently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, makeUnit, makeApplicant, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { bookingsWithoutPlan, unitsWithMultipleActiveBookings } from '../../../packages/db/prisma/sync-permissions';

const describeIf =
  process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('upgrade reports: bookings with no plan, units with more than one active booking', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  let n = 0;
  async function booking(status: string, unitId?: string) {
    return systemPrisma.booking.create({
      data: {
        companyId: fx.companyId,
        unitId: unitId ?? (await makeUnit(systemPrisma, fx)),
        primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId),
        bookingNumber: `RPT2-${Date.now()}-${n++}`,
        status,
        agreedPricePaise: 100n,
        bookingDate: new Date('2026-01-01'),
      },
    });
  }
  async function plan(bookingId: string, isActive: boolean) {
    await systemPrisma.paymentPlan.create({
      data: { companyId: fx.companyId, bookingId, name: 'p', isCustom: true, version: 1, isActive },
    });
  }

  it('bookingsWithoutPlan counts active bookings with no active plan, and only those', async () => {
    const noPlan = await booking('BOOKED');
    const allottedNoPlan = await booking('ALLOTTED');
    const withPlan = await booking('BOOKED');
    await plan(withPlan.id, true);
    const onlyOldPlan = await booking('REGISTERED');
    await plan(onlyOldPlan.id, false);
    await booking('CANCELLED');

    const rows = await bookingsWithoutPlan(systemPrisma, { companyId: fx.companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBe(fx.companyId);
    expect(rows[0].count).toBe(3);
    expect(rows[0].bookingNumbers.sort()).toEqual(
      [noPlan.bookingNumber, allottedNoPlan.bookingNumber, onlyOldPlan.bookingNumber].sort(),
    );
  });

  it('unitsWithMultipleActiveBookings counts units with two or more active bookings, and only those', async () => {
    const twice = await makeUnit(systemPrisma, fx);
    const a = await booking('BOOKED', twice);
    const b = await booking('ALLOTTED', twice);
    const cancelledThenRebooked = await makeUnit(systemPrisma, fx);
    await booking('CANCELLED', cancelledThenRebooked);
    await booking('BOOKED', cancelledThenRebooked);

    const rows = await unitsWithMultipleActiveBookings(systemPrisma, { companyId: fx.companyId });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
    const unit = await systemPrisma.unit.findUnique({ where: { id: twice } });
    expect(rows[0].units).toEqual([
      { unitNumber: unit.number, bookingNumbers: [a.bookingNumber, b.bookingNumber].sort() },
    ]);
  });

  it('both change nothing', async () => {
    const before = await systemPrisma.booking.findMany({ where: { companyId: fx.companyId }, orderBy: { id: 'asc' } });
    await bookingsWithoutPlan(systemPrisma, { companyId: fx.companyId });
    await unitsWithMultipleActiveBookings(systemPrisma, { companyId: fx.companyId });
    expect(await systemPrisma.booking.findMany({ where: { companyId: fx.companyId }, orderBy: { id: 'asc' } })).toEqual(before);
  });
});
