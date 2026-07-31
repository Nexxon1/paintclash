import { describe, expect, it } from 'vitest';

import { runCarveLoad, statsOf } from './harness.js';

/**
 * The harness' own premise, in seconds rather than minutes (the rule the
 * scenario suite lives by, applied here): if the bots never cross each
 * other's plateaus, the budget run would measure an arena in which nothing
 * carves and pass for the wrong reason.
 */
describe('carve-budget harness', () => {
  it('carves: plateaus grow and grooves are really cut into them', () => {
    const run = runCarveLoad({ arenaSizeWU: 200, bots: 8, seconds: 40, seed: 20260730 });
    const stats = statsOf(run);
    // A 6×6 start block is 4 vertices — anything above 8 bots × 4 is fill.
    expect(stats.peakVertices).toBeGreaterThan(32);
    // The premise itself. Deliberately NOT `meanMs > 0` or a rebuild count:
    // both of those stay positive in an arena where no trail ever crosses
    // foreign land — the throttle bookkeeping costs time, and every fill
    // rebuilds a mesh. Verified by disabling band selection: those two pass,
    // this one drops from 59 to 0 — so the floor is set for "grooves happen",
    // well clear of both.
    expect(run.carves).toBeGreaterThan(20);
  });
});
