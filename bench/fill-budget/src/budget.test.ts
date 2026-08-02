import { describe, expect, it } from 'vitest';

import { driftFrom, report, runArena, statsOf } from './harness.js';

/**
 * Five minutes of eight bots painting a map full, guarded on the number that
 * decides what a fill costs: the **vertex count** of the territories it unions.
 *
 * It gated on the stopwatch until ticket 28, and that could not hold. Two
 * separate things broke it:
 *
 * 1. **At 200 WU the arena is genuinely over budget**, and was before this gate
 *    noticed — `bench:steady` measures the overruns across 30 minutes. The "0
 *    ticks over budget" ticket 22 recorded held only because this run ends at
 *    t = 300 s and the first breach fell after it. When tickets 19 and 26
 *    pulled the breach forward into the window, the gate went red — not at a
 *    new fault, but at a known one drifting into view. The budget question at
 *    200 WU belongs to ticket 23 and is not re-asked here.
 * 2. **ms are the one thing this bench cannot measure twice.** The seed is
 *    pinned and the bots are pure functions of the state, so two runs fly the
 *    identical path: vertices, closures and deaths come out bit-identical. The
 *    stopwatch does not — and `max` least of all, which at 50 WU lands on a
 *    different tick every run and spans nearly a factor of two on geometry that
 *    never moves. An outlier that wanders while the work stands still is the
 *    runtime, not the fill.
 *
 * So the assertions sit on the deterministic side of the run and the timings
 * are printed rather than judged. This is a stricter guard, not a looser one:
 * both effects ticket 28 bisected moved the vertex count by far more than the
 * bound below, so either would have tripped it on the day it landed.
 *
 * The measured numbers live in the README, not in this comment, so they cannot
 * quietly go stale — same rule as `steady.test.ts`.
 *
 * Manual, never CI (spec §9.3): the run simulates ten minutes of arena time.
 */

/**
 * How far the vertex count may sit from its baseline before this is a
 * regression. Wide enough that only a real change in behaviour can trip it:
 * the run is deterministic, so a matching build reads exactly 0 %, and the
 * smaller of the two effects on record is more than twice this. Nothing lives
 * in between — the bound separates "identical" from "different", not "fast"
 * from "slow".
 */
const MAX_VERTEX_DRIFT = 0.05;

/**
 * The recorded path of each arena, measured on ticket 31 (2026-08-02). All
 * three are deterministic outputs of the pinned seed. Re-record them
 * deliberately, in a commit that says why: a changed number here means the
 * arena now paints a different shape, which is exactly the event worth a second
 * look at what it costs.
 *
 * **Both rows moved with ticket 31**, which stopped storing needles — the
 * near-collinear triangles a Martinez sweep leaves where two boundaries almost
 * coincide. They are not land in any sense (105 of them held 5,3e-6 WU²
 * between them), but they were stored as territory, so they were vertices, and
 * they accumulated all round: 105 of the 152 stored pieces at t = 300 s.
 *
 * The two rows moved differently, and the pair is the evidence:
 *
 * - **200 WU flies the identical path** — 1 323 closures and 1 death, bit for
 *   bit — while dropping 7 369 → 7 044 vertices (−4,4 %). Nothing but dead
 *   weight left. That makes it this change's valid A/B column, measured on one
 *   machine, same seed, straight before and after: **mean 0,58 → 0,54 ms, p95
 *   3,31 → 3,10 ms, p99 6,78 → 6,53 ms.**
 * - **50 WU flies a different path** (1 750 → 1 562 vertices, 2 527 → 2 575
 *   closures, 79 → 90 deaths) — and the reason is not the fill but the BOTS.
 *   `closestOnTerritory` walks every ring, and `territoryCenter` averages
 *   outer-ring vertices unweighted, so with 105 three-vertex needles among 152
 *   pieces a bot's "where is my land" and "where is my nearest border" were
 *   partly computed from hairs. At 50 WU — sixteen times the density — that
 *   distortion is thick enough to steer by. The extra deaths are `headOn`
 *   (33 → 46), not total-loss: the bots collide differently, nobody is
 *   dispossessed by the change.
 *
 * 200 WU is the public arena (spec §10.2). 50 WU is `pnpm dev:small`, sixteen
 * times the density the spec sizes for; production caps its bot count by area
 * now (ticket 12 follow-up), but the harness forces eight anyway — it is the
 * saturation case, and it is the one that produced the reported freeze.
 */
const ARENAS = [
  { arenaSizeWU: 200, peakVertices: 7044, closures: 1323, deaths: 1 },
  { arenaSizeWU: 50, peakVertices: 1562, closures: 2575, deaths: 90 },
];

describe('fill cost under a saturating load', () => {
  for (const arena of ARENAS) {
    const { arenaSizeWU, peakVertices, closures, deaths } = arena;
    it(`${String(arenaSizeWU)} WU · 8 bots · 5 min paints its recorded ${String(peakVertices)} vertices`, async () => {
      const run = await runArena({ arenaSizeWU, bots: 8, seconds: 300, seed: 20260730 });
      const stats = statsOf(run);
      const drift = driftFrom(peakVertices, stats.peakVertices);
      const driftPct = `${(drift * 100).toFixed(1)} %`;
      const flown =
        `${String(run.closures)} closures and ${String(run.deaths)} deaths ` +
        `against a recorded ${String(closures)} and ${String(deaths)}`;
      console.log(
        [
          report(run, stats),
          `  vertices ${String(stats.peakVertices)} vs baseline ` +
            `${String(peakVertices)} (${driftPct})`,
        ].join('\n'),
      );
      // The premise first: an arena that painted nothing has a vertex count
      // too, and it would sail past a drift bound by being wrong in both halves.
      expect(
        run.closures,
        `only ${String(run.closures)} loop closures in 300 s — the bots barely painted, ` +
          `so the vertex count below describes an empty arena rather than a fill load`,
      ).toBeGreaterThan(100);
      // Vertices carry the bound because they are what the union pays for, and
      // they move continuously; closures and deaths are counts, so any drift in
      // them at all is a different flown path and reads as an exact mismatch.
      expect(
        Math.abs(drift),
        `peak vertices came out ${String(stats.peakVertices)} against a recorded ` +
          `${String(peakVertices)} (${driftPct}), and this run is deterministic — a ` +
          `matching build reads 0 %. The arena is painting a different shape than when ` +
          `the baseline was taken, so the fill is doing a different amount of work: ` +
          `${flown}. Find out what changed and what it costs before re-recording the ` +
          `baseline`,
      ).toBeLessThan(MAX_VERTEX_DRIFT);
      // Ticket 31: a needle is not land, so nothing above would notice it —
      // not the vertex bound (it moves them by a few per cent at most), not
      // closures, not deaths. It has to be asked for by name.
      expect(
        run.needles,
        `${String(run.needles)} of the ${String(run.pieces)} stored pieces are thinner than ` +
          `a hairline. Those are needles — the near-collinear triangles the boolean sweep ` +
          `leaves where two boundaries almost coincide (ticket 31). They hold no land worth ` +
          `counting, so nothing else in this bench goes red, but they are stored as ` +
          `territory, they never go away, and the renderer extrudes each one into a ` +
          `hairline wall standing on the map`,
      ).toBe(0);
      expect(
        { closures: run.closures, deaths: run.deaths },
        `the arena flew a different path than the baseline records — ${flown}. The ` +
          `vertex count still matched, so the difference is in how the run got there ` +
          `(a death that no longer happens, a capture that now succeeds), not in the ` +
          `size of the territories. Both change what a fill costs`,
      ).toEqual({ closures, deaths });
      // Deliberately not asserted: `stats.maxMs` against the tick budget. See
      // the file comment — at 200 WU it is a known overrun owned by ticket 23,
      // and at 50 WU it is GC noise on a run whose work is fixed. `report`
      // prints both on every run, so neither can go quietly.
    });
  }
});
