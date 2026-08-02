import type { Ring } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { runArena, saturationOf, statsOf, totalVertices } from './harness.js';

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

/**
 * The steady-state run's premise, as arithmetic rather than a 30-minute wait
 * (README rule 8 of the scenario suite): a baseline that never left the ramp
 * is not a baseline. Measured here in milliseconds so a mistake in the window
 * split is not something you discover at the end of a 36 000-tick run.
 */
describe('saturationOf', () => {
  it('reports no comparable window when the run ends inside the settle time', () => {
    expect(saturationOf([1, 2, 3], 10)).toEqual({
      halfWindowSec: 0,
      earlyMeanVertices: 0,
      lateMeanVertices: 0,
      driftFraction: 0,
    });
  });

  it('splits the post-settle series in half and reports the drift between them', () => {
    // Settle drops [9, 9]; the remaining four seconds halve into 100 and 110.
    const saturation = saturationOf([9, 9, 100, 100, 110, 110], 2);
    expect(saturation.halfWindowSec).toBe(2);
    expect(saturation.earlyMeanVertices).toBe(100);
    expect(saturation.lateMeanVertices).toBe(110);
    expect(saturation.driftFraction).toBeCloseTo(0.1, 10);
  });

  it('reads a shrinking series as negative drift', () => {
    expect(saturationOf([0, 200, 100], 1).driftFraction).toBeCloseTo(-0.5, 10);
  });

  it('drops the odd middle second, so both halves are the same width', () => {
    const saturation = saturationOf([10, 999, 20], 0);
    expect(saturation.halfWindowSec).toBe(1);
    expect(saturation.earlyMeanVertices).toBe(10);
    expect(saturation.lateMeanVertices).toBe(20);
  });

  it('calls an arena that painted nothing drift-free rather than dividing by zero', () => {
    // Trivially true, and deliberately not this function's job to catch: that
    // the bots painted at all is a separate premise (`fills`, `peakVertices`).
    expect(saturationOf([0, 0, 0, 0], 0).driftFraction).toBe(0);
  });
});
