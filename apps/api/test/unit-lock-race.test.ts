/**
 * Frozen-core change B: the unit row lock. Every test forces its interleaving
 * with a barrier the test controls (helpers/row-lock-barrier.ts): the test
 * holds FOR NO KEY UPDATE on the unit, starts the requests, waits until they
 * are all blocked behind it, then releases.
 *
 * Without the lock, every request has already read the unit as AVAILABLE when
 * it blocks (at the status UPDATE), so after the release both commit. With
 * the lock, each request blocks before it reads, and the loser re-reads the
 * new status and is refused.
 *
 * Global lock order (comment at UnitStateMachineService.transition()):
 * booking row → number sequence → units (lower id first) → interest advisory
 * lock. The same-financial-year transfer-vs-booking test fails with a
 * deadlock if createBooking takes the unit lock before the booking number.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK, type CreateBookingDto } from '@openestate/shared';
import {
  makeClients,
  buildServices,
  seedCompany,
  makeUnit,
  makeApplicant,
  cleanupCompany,
  type Services,
  type CompanyFixture,
} from './helpers/postsales-harness';
import { holdUnitLock, waitBlockedBehind } from './helpers/row-lock-barrier';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

const DAY = 86_400_000;
const today = () => new Date(new Date().toISOString().slice(0, 10));
// More than a year ago: always a different financial year from today, so the
// booking-number sequence row is different and doesn't serialise the requests.
const otherFy = () => new Date(today().getTime() - 400 * DAY);

describeIf('unit lock: concurrent changes to one unit', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let svc: Services;
  let fx: CompanyFixture;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    svc = buildServices(tenantPrisma, systemPrisma, SYSTEM_CLOCK);
    fx = await seedCompany(systemPrisma);
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await tenantPrisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  async function dto(unitId: string, bookingDate: Date): Promise<CreateBookingDto> {
    return {
      unitId,
      primaryApplicantId: await makeApplicant(systemPrisma, fx.companyId),
      coApplicantIds: [],
      bookingDate,
      costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000_00n, gstRateId: fx.defaultGstRateId }],
    } as CreateBookingDto;
  }

  const book = async (unitId: string, date: Date) =>
    svc.bookings.createBooking(fx.companyId, await dto(unitId, date), fx.userId);
  const transferTo = (bookingId: string, toUnitId: string) =>
    svc.transfers.transfer(fx.companyId, bookingId, { transferType: 'UNIT', toUnitId }, fx.userId);

  const settle = (p: Promise<unknown>) =>
    p.then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, message: e.message }),
    );
  const activeBookings = (unitId: string) =>
    systemPrisma.booking.count({ where: { unitId, status: { in: ['BOOKED', 'ALLOTTED', 'REGISTERED'] } } });
  const unitStatus = async (unitId: string) => (await systemPrisma.unit.findUnique({ where: { id: unitId } })).status;

  it('race 1: two bookings of one unit in different financial years: exactly one wins', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const barrier = await holdUnitLock(systemPrisma, unitId);
    const a = settle(book(unitId, today()));
    const b = settle(book(unitId, otherFy()));
    await waitBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.all([a, b]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser && !loser.ok && loser.message).toContain('only AVAILABLE or HELD units can be booked');
    expect(await activeBookings(unitId)).toBe(1);
    expect(await systemPrisma.ledgerEntry.count({ where: { booking: { unitId } } })).toBe(1);
    expect(await systemPrisma.unitStatusChange.count({ where: { unitId } })).toBe(1);
  });

  it('race 2: a booking against a manual block of the same unit: never a booking on a blocked unit', async () => {
    const unitId = await makeUnit(systemPrisma, fx);
    const barrier = await holdUnitLock(systemPrisma, unitId);
    const booking = settle(book(unitId, today()));
    await waitBlockedBehind(systemPrisma, barrier.pid, 1);
    const block = settle(svc.stateMachine.transition(fx.companyId, unitId, 'BLOCKED', 'user', fx.userId, 'Survey'));
    await waitBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const [rb, rk] = await Promise.all([booking, block]);

    // Either may take the lock first after the release; the invariant must
    // hold either way, and the loser must be refused by the re-check.
    expect([rb, rk].filter((r) => r.ok)).toHaveLength(1);
    if (rb.ok) {
      expect(!rk.ok && rk.message).toContain('Invalid transition from BOOKED to BLOCKED');
      expect(await unitStatus(unitId)).toBe('BOOKED');
      expect(await activeBookings(unitId)).toBe(1);
    } else {
      expect(rb.message).toContain('only AVAILABLE or HELD units can be booked');
      expect(await unitStatus(unitId)).toBe('BLOCKED');
      expect(await activeBookings(unitId)).toBe(0);
    }
  });

  it('transfer 1: A→B and B→A at once: both refused, no deadlock, nothing changes', async () => {
    const unitA = await makeUnit(systemPrisma, fx);
    const unitB = await makeUnit(systemPrisma, fx);
    const x = await book(unitA, today());
    const y = await book(unitB, today());
    const results = await Promise.all([settle(transferTo(x.id, unitB)), settle(transferTo(y.id, unitA))]);

    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain('Destination unit is BOOKED');
      expect(!r.ok && r.message).not.toMatch(/deadlock/i);
    }
    expect(await unitStatus(unitA)).toBe('BOOKED');
    expect(await unitStatus(unitB)).toBe('BOOKED');
    expect(await systemPrisma.booking.count({ where: { id: { in: [x.id, y.id] }, status: 'BOOKED' } })).toBe(2);
  });

  it('transfer 2: A→C and B→C at once: exactly one moves to C', async () => {
    const unitA = await makeUnit(systemPrisma, fx);
    const unitB = await makeUnit(systemPrisma, fx);
    const unitC = await makeUnit(systemPrisma, fx);
    const x = await book(unitA, today());
    const y = await book(unitB, today());
    const barrier = await holdUnitLock(systemPrisma, unitC);
    const r1 = settle(transferTo(x.id, unitC));
    const r2 = settle(transferTo(y.id, unitC));
    await waitBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.all([r1, r2]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results) expect(!r.ok && r.message ? r.message : '').not.toMatch(/deadlock/i);
    expect(await activeBookings(unitC)).toBe(1);
    expect((await activeBookings(unitA)) + (await activeBookings(unitB))).toBe(1);
  });

  it('transfer 3a: a transfer into U and a booking of U in different financial years: exactly one wins', async () => {
    const unitA = await makeUnit(systemPrisma, fx);
    const unitU = await makeUnit(systemPrisma, fx);
    const x = await book(unitA, today());
    const barrier = await holdUnitLock(systemPrisma, unitU);
    const booking = settle(book(unitU, otherFy()));
    await waitBlockedBehind(systemPrisma, barrier.pid, 1);
    const transfer = settle(transferTo(x.id, unitU));
    await waitBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.all([booking, transfer]);

    // Either may take the lock first; the loser is refused by its own
    // re-check under the lock.
    const [rb, rt] = results;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    if (rb.ok) expect(!rt.ok && rt.message).toContain('Destination unit is BOOKED');
    else expect(rb.message).toContain('only AVAILABLE or HELD units can be booked');
    expect(await activeBookings(unitU)).toBe(1);
  });

  it('transfer 3b: a transfer into U and a booking of U in the same financial year: no deadlock, exactly one wins', async () => {
    const unitA = await makeUnit(systemPrisma, fx);
    const unitU = await makeUnit(systemPrisma, fx);
    const x = await book(unitA, today());
    const barrier = await holdUnitLock(systemPrisma, unitU);
    const booking = settle(book(unitU, today()));
    await waitBlockedBehind(systemPrisma, barrier.pid, 1);
    const transfer = settle(transferTo(x.id, unitU));
    await waitBlockedBehind(systemPrisma, barrier.pid, 2);
    await barrier.release();
    const results = await Promise.all([booking, transfer]);

    for (const r of results) expect(!r.ok && r.message ? r.message : '').not.toMatch(/deadlock/i);
    // Either may take the lock first; the loser is refused by its own
    // re-check under the lock.
    const [rb, rt] = results;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    if (rb.ok) expect(!rt.ok && rt.message).toContain('Destination unit is BOOKED');
    else expect(rb.message).toContain('only AVAILABLE or HELD units can be booked');
    expect(await activeBookings(unitU)).toBe(1);
  });

  it('transfer 4: the destination is booked while the transfer waits for its lock: the transfer is refused by its re-check', async () => {
    const unitA = await makeUnit(systemPrisma, fx);
    const unitU = await makeUnit(systemPrisma, fx);
    const x = await book(unitA, today());
    const barrier = await holdUnitLock(systemPrisma, unitU);
    const transfer = settle(transferTo(x.id, unitU));
    await waitBlockedBehind(systemPrisma, barrier.pid, 1);
    // The barrier itself marks U booked and commits, as a competing booking would.
    await barrier.release('BOOKED');
    const r = await transfer;

    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('Destination unit is BOOKED');
    expect(await systemPrisma.booking.findUnique({ where: { id: x.id } })).toMatchObject({ status: 'BOOKED', unitId: unitA });
    expect(await unitStatus(unitA)).toBe('BOOKED');
  });
});
