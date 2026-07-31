import type { Ring } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { runArena, statsOf, totalVertices } from './harness.js';

/**
 * The harness' own premise, in seconds rather than minutes (README rule 2 of
 * the scenario suite, applied here): if the bots do not actually paint, the
 * budget run below would measure an empty arena and pass for the wrong reason.
 */
describe('fill-budget harness', () => {
  it('paints: bots fill, territories grow vertices', () => {
    const run = runArena({ arenaSizeWU: 200, bots: 8, seconds: 20, seed: 20260730 });
    expect(run.fills).toBeGreaterThan(10);
    const stats = statsOf(run);
    // A 6×6 start block is 4 vertices — anything above 8 bots × 4 is fill.
    expect(stats.peakVertices).toBeGreaterThan(32);
    expect(stats.meanMs).toBeGreaterThan(0);
  });

  it('counts vertices across rings, holes included', () => {
    const triangle: Ring = [
      [0, 0],
      [4, 0],
      [4, 4],
    ];
    const hole: Ring = [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
    ];
    expect(totalVertices([])).toBe(0);
    // One territory, one polygon, outer ring + hole ring.
    expect(totalVertices([[[triangle, hole]]])).toBe(7);
    // Two territories count independently.
    expect(totalVertices([[[triangle]], [[triangle]]])).toBe(6);
  });
});
