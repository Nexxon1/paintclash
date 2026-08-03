import { describe, expect, it } from 'vitest';

import { meanAfter, plateauOf, report, runBandwidth, savingFactor } from './harness.js';

/**
 * Ticket 29's two measurements, in one run: what the full-territory send path
 * costs a client per second today, and what decimating the send copy would
 * save it.
 *
 * Four hours of arena time, and the settle and drift bounds below are lifted
 * from `bench/fill-budget`'s steady-state run for the reason that bench had to
 * learn the hard way: the territory curve is a SAWTOOTH with a period of tens
 * of minutes — territories grow, someone dies, their land resets to a 6×6 block
 * — so a half-window narrower than several periods measures the phase it landed
 * in and calls it a trend. Egress is a function of that same curve, so it
 * inherits the same rule and the same window.
 *
 * What it asserts is its own premise — that the run reached the plateau, that
 * the bots painted, that the sweep is not measuring the same geometry twice. It
 * deliberately does NOT gate on a byte target: ticket 29 is `needs-triage` and
 * its acceptance is "measure and estimate before rebuilding", so there is no
 * agreed budget to hold, and a bench that fails on a human-gated finding is a
 * permanently red bench. The measured numbers live in the README, not in a
 * comment here, so they cannot quietly go stale.
 */

/**
 * Arena seconds dropped before measuring. Generous, and the same number
 * `fill-budget` uses: the ramp is over after ~7 min, but the first sawtooth peak
 * lands around t = 1 300 s and including it drags the early half up.
 */
const SETTLE_SEC = 1800;

/** Arena seconds. Four hours holds three to five sawtooth cycles. */
const STEADY_SEC = 14_400;

/** What `plateauOf` must halve the tail into — pinned, not re-derived. */
const EXPECTED_HALF_WINDOW_SEC = (STEADY_SEC - SETTLE_SEC) / 2;

/** Both halves of the tail must agree within this, or it is not a plateau. */
const MAX_DRIFT = 0.15;

/**
 * The tolerances the send-path decimation is priced at, in WU, read against
 * what a player can see: the trail is 1 WU wide (`BALANCE.trail.widthWU`), the
 * grid square is 10 WU.
 *
 * - **0,05 WU** — 5 % of the trail width. Ticket 23 measured this as the
 *   coarsest tolerance that leaves the SIM geometry honest, and got 1,11× for
 *   it. Carried here as the anchor between the two measurements.
 * - **0,10 WU** — what `carve.ts` already ships for full recarves, called
 *   invisible there against a 1,2 WU groove.
 * - **0,25 / 0,50 / 1,00 WU** — a quarter, a half and the whole trail width.
 *   Nothing the sim would tolerate; the question is whether the *display* does,
 *   which is exactly what ticket 23's table does not answer.
 */
const TOLERANCES_WU = [0.05, 0.1, 0.25, 0.5, 1] as const;

/** Wall-clock ceiling — generous: a slow runner is slow, not red. */
const TIMEOUT_MS = 1_800_000;

describe('territory egress in the saturated steady state', () => {
  it(
    '200 WU · 8 bots · 4 h reports what a client receives and what decimation would save',
    async () => {
      const run = await runBandwidth({
        arenaSizeWU: 200,
        bots: 8,
        seconds: STEADY_SEC,
        seed: 20260730,
        tolerancesWU: [...TOLERANCES_WU],
      });
      console.log(report(run, SETTLE_SEC));

      const plateau = plateauOf(run.bytesPerSecond, SETTLE_SEC);
      const drift = (plateau.driftFraction * 100).toFixed(1);
      // Premises first, because a drift of 0 is also what `plateauOf` reports
      // for a run it cannot judge at all (no comparable window, or an arena
      // nobody painted in). Asserting only the drift would let exactly those
      // two cases read as a perfect plateau.
      expect(
        plateau.halfWindowSec,
        `the two comparison windows came out ${String(plateau.halfWindowSec)} s wide instead ` +
          `of ${String(EXPECTED_HALF_WINDOW_SEC)} s — a ${String(STEADY_SEC)} s run minus a ` +
          `${String(SETTLE_SEC)} s settle no longer halves as this test assumes, so the drift ` +
          `below compares the wrong slices`,
      ).toBe(EXPECTED_HALF_WINDOW_SEC);
      expect(
        run.closures,
        `only ${String(run.closures)} loop closures in ${String(STEADY_SEC)} s — the bots ` +
          `barely painted, so there is no egress this run could describe`,
      ).toBeGreaterThan(100);
      expect(
        run.fillFrames,
        'the arena closed loops but the send path emitted no fill frame — the two are the ' +
          'same event, so this is a harness bug, not a quiet arena',
      ).toBeGreaterThan(100);
      // Names itself: without a plateau the numbers above describe the ramp.
      expect(
        Math.abs(plateau.driftFraction),
        `egress still moved ${drift} % between the two halves of the tail ` +
          `(${plateau.earlyMean.toFixed(0)} → ${plateau.lateMean.toFixed(0)} bytes/s) — this ` +
          `run never reached a plateau, so its egress is not a steady-state baseline`,
      ).toBeLessThan(MAX_DRIFT);

      // The sweep's own premise: the coarsest tolerance must actually shrink the
      // frame. A table whose "after" column equals its "before" column is the
      // one failure this bench could not spot by reading its own output.
      const baseline = meanAfter(run.bytesPerSecond, SETTLE_SEC);
      const coarsest = run.tolerances[run.tolerances.length - 1];
      const saving = savingFactor(baseline, meanAfter(coarsest?.bytesPerSecond ?? [], SETTLE_SEC));
      expect(
        saving,
        `the coarsest tolerance (${String(coarsest?.epsilonWU)} WU) saved ` +
          `${saving.toFixed(2)}× — at a full trail width of tolerance the frames did not ` +
          `shrink, so the sweep is priced against the wrong geometry`,
      ).toBeGreaterThan(1.1);
      expect(
        coarsest?.deviationSamples ?? 0,
        'no frame was sampled for outline deviation, so the sweep reports a saving with no ' +
          'error term beside it',
      ).toBeGreaterThan(10);
    },
    TIMEOUT_MS,
  );
});
