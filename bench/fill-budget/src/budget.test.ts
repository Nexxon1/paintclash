import { describe, expect, it } from 'vitest';

import { report, runArena, statsOf, TICK_BUDGET_MS } from './harness.js';

/**
 * The acceptance measurement of ticket 22: five minutes of eight bots painting
 * a map full must not cost a single tick more than the 20 Hz budget.
 *
 * Two arenas, because they fail differently. 200 WU is the public arena
 * (spec §10.2) — the case that must hold. 50 WU is `pnpm dev:small`, sixteen
 * times the density the spec sizes for; production caps its bot count by area
 * now (ticket 12 follow-up), but the harness forces eight anyway: it is the
 * saturation case, and it is the one that produced the reported freeze.
 *
 * Manual, never CI (spec §9.3): the run simulates ten minutes of arena time.
 */
describe('tick budget under a saturating fill load', () => {
  for (const arenaSizeWU of [200, 50]) {
    it(`${String(arenaSizeWU)} WU · 8 bots · 5 min stays under ${String(TICK_BUDGET_MS)} ms per tick`, () => {
      const run = runArena({ arenaSizeWU, bots: 8, seconds: 300, seed: 20260730 });
      const stats = statsOf(run);
      console.log(report(run, stats));
      expect(stats.maxMs).toBeLessThan(TICK_BUDGET_MS);
    });
  }
});
