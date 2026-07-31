import { describe, expect, it } from 'vitest';

import { FRAME_BUDGET_MS, report, runCarveLoad, statsOf } from './harness.js';

/**
 * The acceptance measurement of ticket 25: five minutes of eight bots painting
 * the public arena full must not cost a single frame more carve than the frame
 * itself. The freeze this bench was written for was a single 4,3-second carve.
 *
 * Manual, never CI (spec §9.3): the run simulates five minutes of arena time.
 */
describe('frame budget under a saturating carve load', () => {
  it(`200 WU · 8 bots · 5 min keeps the carve under ${FRAME_BUDGET_MS.toFixed(1)} ms per frame`, () => {
    const run = runCarveLoad({ arenaSizeWU: 200, bots: 8, seconds: 300, seed: 20260730 });
    const stats = statsOf(run);
    console.log(report(run, stats));
    expect(stats.maxMs).toBeLessThan(FRAME_BUDGET_MS);
  });
});
