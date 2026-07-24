import type { Point, Territory } from '@paintclash/shared';
import { pointInTerritory, territoryArea } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

import { boundsOverlap, CARVE_WIDTH_WU, carveTerritory, pointsBounds } from './carve.js';

/** 10×10 plateau on (0..10)². */
const plateau = (): Territory => [
  [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  ],
];

describe('carveTerritory (spec §4.1: trail carve-through groove)', () => {
  it('a straight crossing cuts a through-groove of the carve width', () => {
    const trail: Point[] = [
      [-2, 5],
      [12, 5],
    ];
    const carved = carveTerritory(plateau(), [trail]);
    // The groove floor is gone from the plateau …
    expect(pointInTerritory(5, 5, carved)).toBe(false);
    expect(pointInTerritory(5, 5 + CARVE_WIDTH_WU / 2 - 0.05, carved)).toBe(false);
    // … while land beyond the groove walls stays.
    expect(pointInTerritory(5, 5 + CARVE_WIDTH_WU / 2 + 0.05, carved)).toBe(true);
    expect(pointInTerritory(5, 5 - CARVE_WIDTH_WU / 2 - 0.05, carved)).toBe(true);
    expect(territoryArea(carved)).toBeCloseTo(100 - 10 * CARVE_WIDTH_WU, 2);
  });

  it('a polyline groove covers its joints — no gaps at direction changes', () => {
    const trail: Point[] = [
      [-2, 3],
      [5, 3],
      [5, 12],
    ];
    const carved = carveTerritory(plateau(), [trail]);
    // The corner point itself sits in the groove.
    expect(pointInTerritory(5, 3, carved)).toBe(false);
    // Both legs carved.
    expect(pointInTerritory(2, 3, carved)).toBe(false);
    expect(pointInTerritory(5, 8, carved)).toBe(false);
    // The inner corner of the far quadrant survives.
    expect(pointInTerritory(8, 8, carved)).toBe(true);
  });

  it('a trail far away leaves the territory untouched (same reference)', () => {
    const territory = plateau();
    const trail: Point[] = [
      [50, 50],
      [60, 50],
    ];
    expect(carveTerritory(territory, [trail])).toBe(territory);
  });

  it('empty inputs carve nothing', () => {
    const territory = plateau();
    expect(carveTerritory(territory, [])).toBe(territory);
    expect(carveTerritory([], [[[0, 0] as Point, [1, 1] as Point]])).toEqual([]);
  });

  it('degenerate zero-length segments are skipped, not crashed on', () => {
    const trail: Point[] = [
      [5, 5],
      [5, 5],
      [5, 5],
    ];
    const carved = carveTerritory(plateau(), [trail]);
    // Nothing but (at most) the stationary dot's stamp changes.
    expect(territoryArea(carved)).toBeGreaterThan(90);
  });
});

describe('bounds helpers', () => {
  it('pointsBounds spans the polyline, null when empty', () => {
    expect(pointsBounds([])).toBeNull();
    expect(
      pointsBounds([
        [1, 7],
        [4, 2],
      ]),
    ).toEqual({ minX: 1, minY: 2, maxX: 4, maxY: 7 });
  });

  it('boundsOverlap honors the margin', () => {
    const a = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const b = { minX: 2, minY: 0, maxX: 3, maxY: 1 };
    expect(boundsOverlap(a, b, 0.5)).toBe(false);
    expect(boundsOverlap(a, b, 1.5)).toBe(true);
  });
});
