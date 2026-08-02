import { describe, expect, it } from 'vitest';

import { report, runArena, saturationOf, statsOf } from './harness.js';

/**
 * Four hours of arena time — long enough that the answer is about the arena
 * and not about the window it was measured in.
 *
 * The five-minute acceptance run next door is over before the arena reaches
 * the state it spends the rest of its life in. This file used to answer that
 * with thirty minutes, and thirty minutes turned out to be the same mistake
 * one size up: it reported "never reached a plateau" (+33,3 %, then +19,1 %)
 * for an arena that had in fact been at equilibrium for twenty of those
 * minutes. The vertex count is a SAWTOOTH — territories grow, someone dies,
 * their land resets to a 6×6 block — and its period is tens of minutes, so
 * two 11-minute half-windows were comparing a trough against a peak and
 * reading the difference as growth. Measured over four hours the same
 * comparison reads **−3,2 %**, and the curve oscillates between ~5 000 and
 * ~10 500 vertices with no trend at all.
 *
 * Hence both numbers below, and the rule behind them: **a half-window must be
 * several sawtooth periods wide, or it measures the phase it happened to
 * land in.** 6 300 s per half holds three to five cycles.
 *
 * What it asserts is its own premise — that the run reached the plateau —
 * because costs taken from the ramp would understate the steady state they
 * describe. It deliberately does NOT assert the tick budget: ticket 23's
 * acceptance is "the measurement plus the decision", not "budget held", and a
 * bench that fails on a human-gated finding is a permanently red bench. The
 * measured numbers live in the README, not in a comment here, so they cannot
 * quietly go stale.
 */

/**
 * Arena seconds dropped before measuring. Generous: the ramp itself is over
 * after ~7 min, but the first sawtooth peak lands around t = 1 300 s and
 * including it drags the early half up.
 */
const SETTLE_SEC = 1800;

/** Arena seconds per run. ~6,5 min of wall clock at 200 WU, ~1,5 at 50 WU. */
const STEADY_SEC = 14_400;

/** What `saturationOf` must halve the tail into — pinned, not re-derived. */
const EXPECTED_HALF_WINDOW_SEC = (STEADY_SEC - SETTLE_SEC) / 2;

/**
 * Both halves of the tail must agree within this, or it is not a plateau.
 *
 * At the window width above, a plateau reads **−3,2 %** (200 WU) and
 * **0,0 %** (50 WU, 1 139 → 1 139). 15 % leaves four times that much room for
 * sawtooth phase, and still catches the thing this premise is for: a curve
 * that is genuinely climbing. It is not a flatness grade — read the drift the
 * run prints, not just the pass.
 *
 * Sized against a real false alarm rather than in the abstract: the same
 * comparison over 11-minute halves read +33,3 % on this very arena, because
 * the halves were narrower than one sawtooth. A tighter bound here would not
 * have caught that; a wider WINDOW did.
 */
const MAX_DRIFT = 0.15;

/** Wall-clock ceiling per run — generous: a slow runner is slow, not red. */
const TIMEOUT_MS = 1_800_000;

describe('tick cost in the saturated steady state', () => {
  for (const arenaSizeWU of [200, 50]) {
    it(
      `${String(arenaSizeWU)} WU · 8 bots · 4 h reaches a plateau and reports its cost`,
      async () => {
        const run = await runArena({ arenaSizeWU, bots: 8, seconds: STEADY_SEC, seed: 20260730 });
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
          run.closures,
          `only ${String(run.closures)} loop closures in ${String(STEADY_SEC)} s — the bots barely ` +
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
