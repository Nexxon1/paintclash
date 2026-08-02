import { describe, expect, it } from 'vitest';

import { report, runArena, saturationOf, statsOf } from './harness.js';

/**
 * Thirty minutes of arena time — the baseline ticket 23 asks for, and the one
 * measurement `budget.test.ts` structurally cannot make.
 *
 * The five-minute acceptance run next door ends at t = 300 s and reports zero
 * ticks over budget. Locally the overruns start at t = 355 s. That run is not
 * wrong; it is simply over before the arena reaches the state it spends the
 * rest of its life in — the vertex count only settles after ~7 min, and the
 * tick cost settles with it. Anything judged on five minutes is judged on the
 * ramp.
 *
 * So this file deliberately does NOT assert the budget: ticket 23's acceptance
 * is "the measurement plus the decision", not "budget held", and the plateau is
 * already known to break it. Asserting it would turn a known, human-gated
 * finding into a permanently red bench. What it does assert is its own premise
 * — that the run actually reached the plateau — because a baseline taken from
 * the ramp would understate the steady state it is meant to describe. The
 * measured numbers live in the README, not in a comment here, so they cannot
 * quietly go stale.
 */

/** Arena seconds dropped before measuring: the vertex count settles at ~7 min. */
const SETTLE_SEC = 450;

/** Arena seconds per run. */
const STEADY_SEC = 1800;

/** What `saturationOf` must halve the tail into — pinned, not re-derived. */
const EXPECTED_HALF_WINDOW_SEC = (STEADY_SEC - SETTLE_SEC) / 2;

/**
 * Both halves of the tail must agree within this, or it is not a plateau.
 *
 * Sized from the two measurements that exist, neither of which sits near it: a
 * plateau read **−1,8 %** (ticket 23, 2026-07-31), a runaway reads **+33,3 %**
 * (2026-08-02). 15 % splits the two and stays well clear of the plateau, so
 * ordinary sawtooth wobble cannot trip it — this premise exists to catch a
 * curve that is still climbing, not to grade flatness.
 */
const MAX_DRIFT = 0.15;

/** Wall-clock ceiling per run — generous: a slow runner is slow, not red. */
const TIMEOUT_MS = 1_800_000;

describe('tick cost in the saturated steady state', () => {
  for (const arenaSizeWU of [200, 50]) {
    it(
      `${String(arenaSizeWU)} WU · 8 bots · 30 min reaches a plateau and reports its cost`,
      () => {
        const run = runArena({ arenaSizeWU, bots: 8, seconds: STEADY_SEC, seed: 20260730 });
        const stats = statsOf(run);
        const saturation = saturationOf(run.verticesPerSecond, SETTLE_SEC);
        const drift = (saturation.driftFraction * 100).toFixed(1);
        console.log(
          [
            report(run, stats),
            `  plateau (2 × ${String(saturation.halfWindowSec)} s after a ` +
              `${String(SETTLE_SEC)} s settle): ` +
              `${saturation.earlyMeanVertices.toFixed(0)} → ` +
              `${saturation.lateMeanVertices.toFixed(0)} vertices (${drift} %)`,
            `  over budget: ${((100 * stats.overBudget) / run.tickMs.length).toFixed(2)} % ` +
              `of ${String(run.tickMs.length)} ticks`,
          ].join('\n'),
        );
        // Premises first, because a drift of 0 is also what `saturationOf`
        // reports for a run it cannot judge at all (no comparable window, or
        // an arena nobody painted in). Asserting only the drift would let
        // exactly those two cases read as a perfect plateau.
        expect(
          saturation.halfWindowSec,
          `the two comparison windows came out ${String(saturation.halfWindowSec)} s wide ` +
            `instead of ${String(EXPECTED_HALF_WINDOW_SEC)} s — a ${String(STEADY_SEC)} s run ` +
            `minus a ${String(SETTLE_SEC)} s settle no longer halves as this test assumes, ` +
            `so the drift below compares the wrong slices`,
        ).toBe(EXPECTED_HALF_WINDOW_SEC);
        expect(
          run.fills,
          `only ${String(run.fills)} fills in ${String(STEADY_SEC)} s — the bots barely ` +
            `painted, so there is no territory whose cost this run could describe`,
        ).toBeGreaterThan(100);
        // Names itself: without a plateau the numbers above describe the ramp.
        expect(
          Math.abs(saturation.driftFraction),
          `vertices still moved ${drift} % between the two halves of the tail ` +
            `(${saturation.earlyMeanVertices.toFixed(0)} → ` +
            `${saturation.lateMeanVertices.toFixed(0)}) — this run never reached ` +
            `a plateau, so its tick costs are not a steady-state baseline`,
        ).toBeLessThan(MAX_DRIFT);
      },
      TIMEOUT_MS,
    );
  }
});
