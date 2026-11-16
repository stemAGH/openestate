/**
 * Property-based ledger correctness (fast-check).
 *
 * For thousands of random operation sequences (receipts, receipt reversals,
 * extra charges, interest waivers) on a booking, assert after EVERY step:
 *   1. service balance === reference model balance  (balance == Σ signed)
 *   2. append-only: the ledger entry count never decreases
 *   3. Σ receipt allocations === receipt gross (enforced by the service)
 *
 * numRuns: CI default 2000, local dev 500, overridable via PROPERTY_NUM_RUNS.
 * A run below the CI default of 2000 while CI=true and no explicit override
 * fails loudly. Reproducibility: fast-check prints the failing seed + counter-
 * example path; pin it with FC_SEED to replay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { SYSTEM_CLOCK } from '@openestate/shared';
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

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const CI_DEFAULT = 2000;
const LOCAL_DEFAULT = 500;

function resolveNumRuns(): number {
  const override = process.env.PROPERTY_NUM_RUNS;
  if (override) return Number(override);
  const inCi = !!process.env.CI;
  return inCi ? CI_DEFAULT : LOCAL_DEFAULT;
}

type Cmd =
  | { t: 'extra'; rupees: number }
  | { t: 'receipt'; pct: number }
  | { t: 'reverse' }
  | { t: 'waive'; rupees: number };

describeIf('Ledger property: balance == Σ(ledger) for random sequences', () => {
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
    // This 300s timeout is TEARDOWN-ONLY, not a signal about ledger runtime
    // performance: cleanupCompany bulk-deletes every booking (and its cost
    // lines, installments, ledger entries, receipts, …) created across every
    // property-test run in one GUC-scoped transaction. At the CI-floor 2000
    // runs that's ~2000 bookings' worth of rows to delete, which alone can
    // approach vitest's default 10s afterAll hook timeout — the ledger
    // WRITES during the test itself stay fast throughout (each run posts a
    // handful of entries in well under a second; see the per-test durations
    // in CI output). Do not read this timeout as "the ledger is slow."
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  }, 300_000);

  // Timeout is 1_800_000 (30min) at the 500-run PR/push strength, not the
  // old 600_000 — raised as part of the Phase 7 CI-reliability fix
  // (CLAUDE.md's Decisions log). The old 600s timeout was tight enough
  // that CPU/IO contention under the FULL concurrent suite (not this test
  // in isolation, which finishes in ~96s at 500 runs) could push a real,
  // still-succeeding run past it. Vitest's it(fn, timeout) only stops
  // AWAITING on timeout — it does not cancel the in-flight fast-check
  // loop, which kept issuing real Postgres writes concurrently with
  // afterAll's cleanupCompany() delete sweep, producing a genuine 40P01
  // deadlock (confirmed via the Postgres server's own log, not just the
  // client-side error). Raising the timeout removes the false-positive
  // trigger for that self-race rather than papering over the race
  // itself; the vitest maxForks cap (vitest.config.ts) additionally
  // reduces the contention that made 600s too tight in the first place.
  //
  // At the CI_DEFAULT 2000-run nightly/workflow_dispatch strength, 30min
  // is NOT enough — confirmed by a real failure, not assumed: a genuine
  // workflow_dispatch run (2026-08-29) hit exactly this 1_800_000ms
  // timeout with the test still in flight (fast-check had not finished
  // 2000 iterations), killed by vitest's own it() timeout, not GitHub
  // Actions' job-level timeout-minutes (raised to 90 for schedule/
  // workflow_dispatch in the same fix that surfaced this). The two
  // timeouts are independent knobs — raising the job's 30min ceiling to
  // 90min (ci.yml) does nothing for this test's own internal 30min
  // ceiling, which fires first regardless of how much job budget remains.
  // PROPERTY_TEST_TIMEOUT_MS below scales with numRuns so the 500-run
  // path keeps its already-proven-sufficient 30min budget unchanged,
  // while the 2000-run path gets enough headroom (80min) to actually
  // finish inside the 90min job budget rather than being killed by its
  // own stopwatch partway through. 80min (not a tighter value closer to
  // the observed 30.1min failure point) is deliberate: the failed run
  // only proves the test needed MORE than 30min, not how much more —
  // fast-check's loop doesn't report interim progress, so there is no
  // way to know from that one data point whether it was close to done
  // or a third of the way through. GitHub Actions' own job timeout
  // (360min default, or 90min for schedule/workflow_dispatch since the
  // ci.yml fix) is still the real backstop against a genuine hang.
  const numRunsForTimeout = resolveNumRuns();
  const PROPERTY_TEST_TIMEOUT_MS = numRunsForTimeout >= CI_DEFAULT ? 80 * 60_000 : 30 * 60_000;
  it(`holds across ${numRunsForTimeout} random sequences`, async () => {
    const numRuns = resolveNumRuns();
    // Explicit, unconditional log — not just the test title above. A test
    // NAME is invisible to some reporters (the JSON reporter CI uses for
    // its "fail if any test was skipped" check only surfaces pass/fail
    // counts, not names) and easy to skim past in a long log. This line
    // is how the turbo strict-envMode bug that stripped PROPERTY_NUM_RUNS
    // in both local and real CI runs (CLAUDE.md's Phase 7→8 gate decision)
    // got caught in the first place — printing the RAW env value alongside
    // the resolved one means a future divergence between "what was
    // intended" and "what the process actually saw" is visible in every
    // CI log, not something you have to go instrument for again.
    console.log(
      `[postsales-property] effective numRuns=${numRuns} ` +
        `(PROPERTY_NUM_RUNS=${process.env.PROPERTY_NUM_RUNS ?? '<unset>'}, ` +
        `CI=${process.env.CI ?? '<unset>'}, ` +
        `FC_SEED=${process.env.FC_SEED ?? '<unset>'})`,
    );
    if (!process.env.PROPERTY_NUM_RUNS && process.env.CI && numRuns < CI_DEFAULT) {
      throw new Error(
        `Property test numRuns (${numRuns}) is below the CI floor of ${CI_DEFAULT}. ` +
          `Set PROPERTY_NUM_RUNS explicitly to override.`,
      );
    }

    const cmd = fc.oneof(
      fc.record({ t: fc.constant('extra' as const), rupees: fc.integer({ min: 1, max: 100000 }) }),
      fc.record({ t: fc.constant('receipt' as const), pct: fc.integer({ min: 1, max: 100 }) }),
      fc.record({ t: fc.constant('reverse' as const) }),
      fc.record({ t: fc.constant('waive' as const), rupees: fc.integer({ min: 1, max: 50000 }) }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { minLength: 1, maxLength: 7 }), async (cmds: Cmd[]) => {
        const unitId = await makeUnit(systemPrisma, fx);
        const applicantId = await makeApplicant(systemPrisma, fx.companyId);

        // Booking: base ₹30,00,000 (no GST) → balance opens at ₹30,00,000.
        const booking = await svc.bookings.createBooking(
          fx.companyId,
          {
            unitId,
            primaryApplicantId: applicantId,
            coApplicantIds: [],
            bookingDate: new Date('2026-06-01'),
            costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 30_00_000n * 100n , gstRateId: fx.defaultGstRateId }],
          },
          fx.userId,
        );
        const plan = await svc.plans.createCustomPlan(
          fx.companyId,
          booking.id,
          {
            name: 'P',
            isCustom: true,
            installments: [
              { label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: 10_00_000n * 100n },
              { label: 'I2', dueDate: new Date('2026-07-15'), amountPaise: 10_00_000n * 100n },
              { label: 'I3', dueDate: new Date('2026-08-15'), amountPaise: 10_00_000n * 100n },
            ],
          },
          fx.userId,
        );

        // Reference model.
        let expected = 30_00_000n * 100n;
        const remaining = new Map<string, bigint>(
          plan.installments.map((i: { id: string; amountPaise: bigint }) => [i.id, i.amountPaise]),
        );
        const liveReceipts: { id: string; cash: bigint; allocs: { installmentId: string; amountPaise: bigint }[] }[] = [];
        let lastCount = await entryCount(booking.id);

        expect(await svc.ledger.balance(fx.companyId, booking.id)).toBe(expected);

        for (const c of cmds) {
          if (c.t === 'extra') {
            const base = BigInt(c.rupees) * 100n;
            await svc.extraCharges.add(fx.companyId, booking.id, { label: 'X', baseAmountPaise: base }, fx.userId);
            expected += base;
          } else if (c.t === 'receipt') {
            const ids = plan.installments.map((i: { id: string }) => i.id);
            const totalLeft = ids.reduce((s: bigint, id: string) => s + (remaining.get(id) ?? 0n), 0n);
            if (totalLeft === 0n) continue;
            let amount = (totalLeft * BigInt(c.pct)) / 100n;
            if (amount === 0n) amount = 1n;
            if (amount > totalLeft) amount = totalLeft;
            // Greedy allocation across installments with remaining.
            const allocations: { installmentId: string; amountPaise: bigint }[] = [];
            let toAllocate = amount;
            for (const id of ids) {
              if (toAllocate === 0n) break;
              const left = remaining.get(id) ?? 0n;
              if (left === 0n) continue;
              const take = left < toAllocate ? left : toAllocate;
              allocations.push({ installmentId: id, amountPaise: take });
              remaining.set(id, left - take);
              toAllocate -= take;
            }
            const receipt = await svc.receipts.createReceipt(
              fx.companyId,
              {
                bookingId: booking.id,
                receiptDate: new Date('2026-06-20'),
                mode: 'NEFT',
                grossAmountPaise: amount,
                allocations,
                tdsDeductedPaise: 0n,
              },
              fx.userId,
            );
            liveReceipts.push({ id: receipt.id, cash: amount, allocs: allocations });
            expected -= amount;
          } else if (c.t === 'reverse') {
            const r = liveReceipts.pop();
            if (!r) continue;
            await svc.receipts.reverseReceipt(fx.companyId, r.id, 'test reversal', fx.userId);
            expected += r.cash;
            // Restore exactly the installment allocations that receipt made.
            for (const a of r.allocs) {
              remaining.set(a.installmentId, (remaining.get(a.installmentId) ?? 0n) + a.amountPaise);
            }
          } else if (c.t === 'waive') {
            // No command here charges interest, so since v0.10.1 (QA-010) a
            // waiver is refused and posts nothing: the balance must not move.
            const amt = BigInt(c.rupees) * 100n;
            await expect(
              svc.interest.waiveInterest(fx.companyId, booking.id, { amountPaise: amt, reason: 'goodwill' }, fx.userId),
            ).rejects.toThrow(/exceeds the interest still waivable/);
          }

          const bal = await svc.ledger.balance(fx.companyId, booking.id);
          expect(bal).toBe(expected);
          const cnt = await entryCount(booking.id);
          expect(cnt).toBeGreaterThanOrEqual(lastCount); // append-only: never shrinks
          lastCount = cnt;
        }
      }),
      { numRuns, seed: process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined },
    );
  }, PROPERTY_TEST_TIMEOUT_MS);

  async function entryCount(bookingId: string): Promise<number> {
    return systemPrisma.ledgerEntry.count({ where: { companyId: fx.companyId, bookingId } });
  }
});

/**
 * Ledger byte-identity — plotted-farmhouse-inventory.md §11.2, the merge
 * gate for BookingService's one-line change (place-of-supply now resolves
 * via unit.project.areaLocation instead of unit.floor.tower.project
 * .areaLocation — see that plan's §10). Proves the frozen service treats a
 * LAND_BASED unit's booking identically to a HIGH_RISE one: same cost
 * lines, same custom plan, same receipt/bounce/reversal sequence in, same
 * ledger out — types, signed amounts, allocations, and cheque status
 * events byte-identical once ids/timestamps/labels are stripped.
 *
 * Calls BookingService directly (not through HTTP), so
 * BookingCostLineVerifier — wired into BookingController.create, upstream
 * of this service — never runs here; that's correct, not a gap, since
 * this test's whole point is proving the SERVICE is shape-agnostic given
 * identical inputs, independent of the new controller-level verifier.
 */
describeIf('Ledger byte-identity: HIGH_RISE vs LAND_BASED booking, identical operations', () => {
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
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('produces byte-identical ledger entries, allocations, and cheque events for both shapes', async () => {
    const applicantId = await makeApplicant(systemPrisma, fx.companyId);

    // HIGH_RISE unit: seedCompany()'s own project defaults to HIGH_RISE.
    const highRiseUnitId = await makeUnit(systemPrisma, fx);
    const highRiseProject = await systemPrisma.project.findUniqueOrThrow({ where: { id: fx.projectId } });

    // LAND_BASED unit: a separate project — Project.shape is immutable
    // per §13.3, so this can't reuse fx.projectId. Same areaLocationId as
    // the HIGH_RISE project, or GST place-of-supply resolution 400s (and,
    // if it silently didn't, would make the two sequences NOT actually
    // identical inputs) — see finance.ts's isIntraStateSupply fail-loud
    // check.
    const landProject = await systemPrisma.project.create({
      data: {
        companyId: fx.companyId,
        name: 'Equivalence Land Project',
        code: `ELP-${Date.now()}`,
        shape: 'LAND_BASED',
        areaLocationId: highRiseProject.areaLocationId,
      },
    });
    const landUnit = await systemPrisma.unit.create({
      data: {
        companyId: fx.companyId,
        projectId: landProject.id,
        shape: 'LAND_BASED',
        floorId: null,
        number: `PLOT-${Date.now()}`,
        status: 'AVAILABLE',
      },
    });

    async function runSequence(unitId: string) {
      const booking = await svc.bookings.createBooking(
        fx.companyId,
        {
          unitId,
          primaryApplicantId: applicantId,
          coApplicantIds: [],
          bookingDate: new Date('2026-06-01'),
          costLines: [{ kind: 'BASE', label: 'Base', baseAmountPaise: 30_00_000n * 100n, gstRateId: fx.defaultGstRateId }],
        },
        fx.userId,
      );
      const plan = await svc.plans.createCustomPlan(
        fx.companyId,
        booking.id,
        {
          name: 'P',
          isCustom: true,
          installments: [
            { label: 'I1', dueDate: new Date('2026-06-15'), amountPaise: 15_00_000n * 100n },
            { label: 'I2', dueDate: new Date('2026-07-15'), amountPaise: 15_00_000n * 100n },
          ],
        },
        fx.userId,
      );
      const [inst1, inst2] = plan.installments as Array<{ id: string }>;

      // Identical receipt sequence: one NEFT receipt against I1 (later
      // reversed), one CHEQUE receipt against I2 (later bounced).
      const neftReceipt = await svc.receipts.createReceipt(
        fx.companyId,
        {
          bookingId: booking.id,
          receiptDate: new Date('2026-06-20'),
          mode: 'NEFT',
          grossAmountPaise: 15_00_000n * 100n,
          allocations: [{ installmentId: inst1.id, amountPaise: 15_00_000n * 100n }],
          tdsDeductedPaise: 0n,
        },
        fx.userId,
      );
      const chequeReceipt = await svc.receipts.createReceipt(
        fx.companyId,
        {
          bookingId: booking.id,
          receiptDate: new Date('2026-06-21'),
          mode: 'CHEQUE',
          grossAmountPaise: 15_00_000n * 100n,
          allocations: [{ installmentId: inst2.id, amountPaise: 15_00_000n * 100n }],
          tdsDeductedPaise: 0n,
        },
        fx.userId,
      );

      // Identical bounce.
      await svc.receipts.recordChequeEvent(
        fx.companyId,
        chequeReceipt.id,
        { status: 'BOUNCED', eventDate: new Date('2026-06-25'), reason: 'insufficient funds' },
        fx.userId,
      );

      // Identical reversal.
      await svc.receipts.reverseReceipt(fx.companyId, neftReceipt.id, 'duplicate entry', fx.userId);

      return booking.id;
    }

    const highRiseBookingId = await runSequence(highRiseUnitId);
    const landBookingId = await runSequence(landUnit.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function normalizedLedger(bookingId: string): Promise<any[]> {
      const rows = await systemPrisma.ledgerEntry.findMany({
        where: { companyId: fx.companyId, bookingId },
        orderBy: [{ entryType: 'asc' }, { createdAt: 'asc' }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({ entryType: r.entryType, signedAmountPaise: r.signedAmountPaise.toString() }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function normalizedAllocations(bookingId: string): Promise<any[]> {
      const rows = await systemPrisma.receiptAllocation.findMany({
        where: { companyId: fx.companyId, receipt: { bookingId } },
        orderBy: [{ amountPaise: 'asc' }, { createdAt: 'asc' }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({ amountPaise: r.amountPaise.toString() }));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function normalizedChequeEvents(bookingId: string): Promise<any[]> {
      const rows = await systemPrisma.chequeStatusEvent.findMany({
        where: { companyId: fx.companyId, receipt: { bookingId } },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((r: any) => ({ status: r.status, reason: r.reason ?? null }));
    }

    expect(await normalizedLedger(landBookingId)).toEqual(await normalizedLedger(highRiseBookingId));
    expect(await normalizedAllocations(landBookingId)).toEqual(await normalizedAllocations(highRiseBookingId));
    expect(await normalizedChequeEvents(landBookingId)).toEqual(await normalizedChequeEvents(highRiseBookingId));

    // Sanity: both actually produced real, non-trivial ledger activity —
    // an equality check between two empty arrays would pass vacuously.
    expect((await normalizedLedger(highRiseBookingId)).length).toBeGreaterThan(0);
  });
});
