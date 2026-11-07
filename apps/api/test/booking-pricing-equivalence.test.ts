/**
 * The pricing move (BookingService.createBooking → booking-pricing.ts) must
 * be a pure move. This property runs the verbatim pre-move code
 * (helpers/legacy-booking-pricing.ts) and the moved code side by side on
 * generated inputs and asserts, for every input:
 *   - the same result (every cost-line field, the agreed price, the place of
 *     supply), or the same exception class and message;
 *   - the same lookups (charge type, GST rate) with the same arguments, in
 *     the same order.
 * No database: the two lookups are an in-memory fake that records each call.
 * Inputs cover GST rates from 0 to 28 including fractional ones, half-paise
 * rounding edges, zero and very large amounts, intra- and inter-state supply,
 * missing state codes, every rate-fallback branch, and ids that don't exist.
 * There is no discount concept in the cost-line model (amounts are >= 0), so
 * none is generated. 2000 runs by default; FC_SEED reproduces a failure.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Prisma } from '@prisma/client';
import { COST_LINE_KIND, type CreateBookingDto } from '@openestate/shared';
import { priceCostLines } from '../src/postsales/booking-pricing';
import { legacyPriceCostLines } from './helpers/legacy-booking-pricing';

const NUM_RUNS = Number(process.env.PROPERTY_NUM_RUNS_PRICING ?? 2000);
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

const COMPANY = '00000000-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RATE_IDS = [id(101), id(102), id(103), id(104)];
const CHARGE_IDS = [id(201), id(202), id(203)];
const MISSING = id(999);

const rate = fc.constantFrom(0, 0.1, 0.25, 1, 3, 5, 7.5, 12, 12.36, 18, 28);
// Half-paise edges: odd amounts and amounts whose tax lands on .5 for common rates.
const amount = fc.oneof(
  fc.bigInt({ min: 0n, max: 300n }),
  fc.bigInt({ min: 0n, max: 10n ** 15n }),
  fc.constantFrom(1n, 2n, 3n, 5n, 10n, 20n, 25n, 40n, 50n, 99n, 100n, 101n, 199n, 10n ** 15n),
  fc.bigInt({ min: 0n, max: 10n ** 9n }).map((b) => b * 2n + 1n),
);
// Mostly valid inputs, so the success path dominates; the rarer branches
// (missing state code, unknown ids) still occur in every run.
const stateCode = fc.oneof<string | null | undefined>(
  { weight: 12, arbitrary: fc.constantFrom('09', '27') },
  { weight: 1, arbitrary: fc.constantFrom(null, undefined) },
);
const maybeRef = (ids: string[]) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constant(undefined) },
    { weight: 6, arbitrary: fc.constantFrom(...ids) },
    { weight: 1, arbitrary: fc.constant(MISSING) },
  );

const scenario = fc.record({
  rates: fc.tuple(rate, rate, rate, rate),
  chargeRates: fc.tuple(
    fc.option(fc.constantFrom(...RATE_IDS, MISSING), { nil: null }),
    fc.option(fc.constantFrom(...RATE_IDS), { nil: null }),
    fc.option(fc.constantFrom(...RATE_IDS), { nil: null }),
  ),
  config: fc.option(fc.record({ gstStateCode: stateCode }), { nil: null, freq: 20 }),
  area: fc.option(fc.record({ stateCode }), { nil: null, freq: 20 }),
  placeOverride: fc.constantFrom<string | undefined>(undefined, undefined, '09', '27'),
  lines: fc.array(
    fc.record({
      kind: fc.constantFrom(...Object.values(COST_LINE_KIND)),
      label: fc.constantFrom('Base Sale Price', 'PLC', 'Parking', 'Club', 'Other'),
      baseAmountPaise: amount,
      gstRateId: maybeRef(RATE_IDS),
      chargeTypeId: maybeRef(CHARGE_IDS),
    }),
    { minLength: 1, maxLength: 4 },
  ),
});

type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function fakeTx(sc: Scenario) {
  const calls: unknown[] = [];
  const rates = new Map(RATE_IDS.map((r, i) => [r, sc.rates[i]]));
  const charges = new Map(CHARGE_IDS.map((c, i) => [c, sc.chargeRates[i]]));
  const tx = {
    chargeType: {
      findFirst: async (args: { where: { id: string; companyId: string } }) => {
        calls.push(['chargeType.findFirst', args]);
        const g = charges.get(args.where.id);
        return g === undefined || args.where.companyId !== COMPANY ? null : { id: args.where.id, gstRateId: g };
      },
    },
    gstRate: {
      findFirst: async (args: { where: { id: string; companyId: string } }) => {
        calls.push(['gstRate.findFirst', args]);
        const r = rates.get(args.where.id);
        return r === undefined || args.where.companyId !== COMPANY ? null : { id: args.where.id, rate: new Prisma.Decimal(r) };
      },
    },
  };
  return { tx, calls };
}

async function run(
  fn: typeof priceCostLines | typeof legacyPriceCostLines,
  sc: Scenario,
): Promise<{ outcome: unknown; calls: unknown[] }> {
  const { tx, calls } = fakeTx(sc);
  const unit = { id: id(1), project: { areaLocation: sc.area } };
  const dto = {
    unitId: id(1),
    primaryApplicantId: id(2),
    coApplicantIds: [],
    bookingDate: new Date('2026-06-15'),
    placeOfSupplyStateCode: sc.placeOverride,
    costLines: sc.lines,
  } as CreateBookingDto;
  try {
    return { outcome: { ok: await fn(tx, COMPANY, unit, sc.config, dto) }, calls };
  } catch (e) {
    return { outcome: { error: (e as Error).constructor.name, message: (e as Error).message }, calls };
  }
}

describe('booking pricing: the moved code is identical to the original', () => {
  it(`same result and same lookups across ${NUM_RUNS} generated bookings`, async () => {
    let priced = 0;
    await fc.assert(
      fc.asyncProperty(scenario, async (sc) => {
        const before = await run(legacyPriceCostLines, sc);
        const after = await run(priceCostLines, sc);
        expect(after.outcome).toEqual(before.outcome);
        expect(after.calls).toEqual(before.calls);
        if ((before.outcome as { ok?: unknown }).ok) priced++;
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
    // The generator must exercise the success path, not only refusals.
    expect(priced).toBeGreaterThan(NUM_RUNS / 10);
  }, 120_000);
});
