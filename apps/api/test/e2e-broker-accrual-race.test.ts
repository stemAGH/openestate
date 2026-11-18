/**
 * A broker change and a commission accrual on the same booking are serialised
 * by the booking row lock (owner ruling 2026-11-18): whichever goes first
 * finishes, and the other then sees its result. Forced interleaving in both
 * orders: the test holds the booking row (FOR NO KEY UPDATE, the lock both
 * take) on its own connection, starts one, waits until it is blocked, starts
 * the other, waits until both are, then releases.
 * - accrual first: commission accrues for the original broker; the broker
 *   change that waited is refused (409);
 * - broker change first: the accrual that waited accrues for the new broker.
 * Either way the accrued commission's broker is the booking's broker.
 *
 * Requires the compiled dist/ and DATABASE_URL_TEST + DATABASE_URL_TEST_SYSTEM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SYSTEM_CLOCK } from '@openestate/shared';
import { setupTwoCompanies, type TwoCompanies } from './helpers/two-companies';
import { makeClients, buildServices, makeUnit, makeApplicant, makeBroker, makeFlatCommissionRule } from './helpers/postsales-harness';
import { countBlockedBehind } from './helpers/row-lock-barrier';

const describeIf = process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST_SYSTEM ? describe : describe.skip;

describeIf('broker change vs commission accrual', () => {
  let t: TwoCompanies;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;
  let brokerX: string;
  let brokerY: string;

  beforeAll(async () => {
    t = await setupTwoCompanies(`brrace${Date.now()}`);
    ({ tenantPrisma } = makeClients());
    svc = buildServices(tenantPrisma, t.systemPrisma, SYSTEM_CLOCK);
    brokerX = await makeBroker(t.systemPrisma, t.A.fx.companyId);
    brokerY = await makeBroker(t.systemPrisma, t.A.fx.companyId);
    await makeFlatCommissionRule(t.systemPrisma, t.A.fx.companyId, brokerX, 1);
    await makeFlatCommissionRule(t.systemPrisma, t.A.fx.companyId, brokerY, 2);
  }, 120_000);

  afterAll(async () => {
    await tenantPrisma?.$disconnect();
    await t?.cleanup();
  });

  async function bookingWithBrokerX() {
    const b = await svc.bookings.createBooking(
      t.A.fx.companyId,
      {
        unitId: await makeUnit(t.systemPrisma, t.A.fx), primaryApplicantId: await makeApplicant(t.systemPrisma, t.A.fx.companyId), coApplicantIds: [],
        bookingDate: new Date('2026-06-01'), costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 10_00_000n, gstRateId: t.A.fx.defaultGstRateId }],
      },
      t.A.fx.userId,
    );
    expect((await t.send('post', `/bookings/${b.id}/broker`, { brokerId: brokerX })).status).toBeLessThan(300);
    return b.id as string;
  }

  async function race(bookingId: string, first: () => Promise<{ status: number; body: unknown }>, second: () => Promise<{ status: number; body: unknown }>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pidReady!: (pid: number) => void;
    const pidP = new Promise<number>((r) => (pidReady = r));
    const holder = t.systemPrisma.$transaction(async (tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<Array<{ pid: number }>> }) => {
      const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid FOR NO KEY UPDATE`;
      pidReady(Number(row.pid));
      await gate;
    }, { timeout: 60_000 });
    const pid = await pidP;
    const p1 = first();
    const blocked1 = await countBlockedBehind(t.systemPrisma, pid, 1);
    const p2 = second();
    const blocked2 = await countBlockedBehind(t.systemPrisma, pid, 2);
    release();
    await holder;
    const [r1, r2] = await Promise.all([p1, p2]);
    return { blocked: [blocked1, blocked2], r1, r2 };
  }

  const accrue = (id: string) => () => t.send('post', `/bookings/${id}/commission/accrue`).then((r) => r);
  const changeBroker = (id: string) => () => t.send('post', `/bookings/${id}/broker`, { brokerId: brokerY }).then((r) => r);
  const accruedBroker = async (id: string) => (await t.systemPrisma.brokerBookingCommission.findFirst({ where: { bookingId: id } }))?.brokerId;
  const bookingBroker = async (id: string) => (await t.systemPrisma.booking.findUnique({ where: { id } })).brokerId;

  it('accrual first: commission accrues for the original broker and the broker change that waited is refused', async () => {
    const id = await bookingWithBrokerX();
    const { blocked, r1, r2 } = await race(id, accrue(id), changeBroker(id));
    expect(blocked).toEqual([1, 2]);
    expect(r1.status, JSON.stringify(r1.body)).toBeLessThan(300);
    expect(r2.status, JSON.stringify(r2.body)).toBe(409);
    expect(await bookingBroker(id)).toBe(brokerX);
    expect(await accruedBroker(id)).toBe(brokerX);
  }, 60_000);

  it('broker change first: the accrual that waited accrues for the new broker', async () => {
    const id = await bookingWithBrokerX();
    const { blocked, r1, r2 } = await race(id, changeBroker(id), accrue(id));
    expect(blocked).toEqual([1, 2]);
    expect(r1.status, JSON.stringify(r1.body)).toBeLessThan(300);
    expect(r2.status, JSON.stringify(r2.body)).toBeLessThan(300);
    expect(await bookingBroker(id)).toBe(brokerY);
    expect(await accruedBroker(id)).toBe(brokerY);
  }, 60_000);
});
