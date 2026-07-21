import type { Point, Ring, Territory } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  appendTrailPoint,
  cloneTerritory,
  distanceToTerritory,
  pointInTerritory,
  ringArea,
  snapWU,
  squareRing,
  territoryArea,
  validPolyTopology,
} from './geometry.js';

const unitSquare: Ring = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];

describe('ringArea', () => {
  it('is the signed shoelace area (CCW positive)', () => {
    expect(ringArea(unitSquare)).toBe(16);
    expect(ringArea([...unitSquare].reverse())).toBe(-16);
  });

  it('is 0 for degenerate rings (empty, single point, collinear)', () => {
    expect(ringArea([])).toBe(0);
    expect(ringArea([[3, 3]])).toBe(0);
    expect(
      ringArea([
        [0, 0],
        [2, 2],
        [4, 4],
      ]),
    ).toBe(0);
  });
});

describe('territoryArea', () => {
  it('sums pieces and subtracts holes (even-odd)', () => {
    const annulus: Territory = [
      [
        squareRing(5, 5, 5), // 10×10 outer = 100
        squareRing(5, 5, 2), // 4×4 hole = 16
      ],
    ];
    expect(territoryArea(annulus)).toBe(84);
    const twoPieces: Territory = [[squareRing(0, 0, 1)], [squareRing(10, 10, 2)]];
    expect(territoryArea(twoPieces)).toBe(4 + 16);
  });

  it('is orientation-independent (holes count by nesting, not winding)', () => {
    const hole = squareRing(5, 5, 2);
    const reversedHole = [...hole].reverse();
    expect(territoryArea([[squareRing(5, 5, 5), hole]])).toBe(
      territoryArea([[squareRing(5, 5, 5), reversedHole]]),
    );
  });

  it('is 0 for an empty territory', () => {
    expect(territoryArea([])).toBe(0);
  });
});

describe('pointInTerritory', () => {
  const territory: Territory = [[squareRing(5, 5, 5), squareRing(5, 5, 2)]];

  it('is true inside the outer ring, false in a hole and outside', () => {
    expect(pointInTerritory(1, 1, territory)).toBe(true); // in the annulus
    expect(pointInTerritory(5, 5, territory)).toBe(false); // in the hole
    expect(pointInTerritory(20, 20, territory)).toBe(false); // outside
    expect(pointInTerritory(-1, 5, territory)).toBe(false);
  });

  it('handles multiple disjoint pieces', () => {
    const two: Territory = [[squareRing(0, 0, 1)], [squareRing(10, 10, 1)]];
    expect(pointInTerritory(0, 0, two)).toBe(true);
    expect(pointInTerritory(10, 10, two)).toBe(true);
    expect(pointInTerritory(5, 5, two)).toBe(false);
  });

  it('is false for empty/degenerate territories', () => {
    expect(pointInTerritory(0, 0, [])).toBe(false);
    expect(pointInTerritory(0, 0, [[]])).toBe(false);
    expect(pointInTerritory(0, 0, [[[[0, 0]]]])).toBe(false);
  });
});

describe('distanceToTerritory', () => {
  const territory: Territory = [[squareRing(5, 5, 5)]]; // 0..10 square

  it('is 0 inside', () => {
    expect(distanceToTerritory(5, 5, territory)).toBe(0);
  });

  it('is the perpendicular distance to the nearest edge outside', () => {
    expect(distanceToTerritory(5, 13, territory)).toBeCloseTo(3);
    expect(distanceToTerritory(-2, 5, territory)).toBeCloseTo(2);
  });

  it('measures to the nearest corner beyond edge ends', () => {
    expect(distanceToTerritory(13, 14, territory)).toBeCloseTo(5); // 3-4-5 to (10,10)
  });

  it('is Infinity for an empty territory', () => {
    expect(distanceToTerritory(0, 0, [])).toBe(Infinity);
  });
});

describe('appendTrailPoint', () => {
  it('appends fresh points', () => {
    const trail: Point[] = [[0, 0]];
    appendTrailPoint(trail, 1, 0);
    appendTrailPoint(trail, 1, 1);
    expect(trail).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('drops exact duplicates (head pinned against a wall)', () => {
    const trail: Point[] = [[0, 0]];
    appendTrailPoint(trail, 0, 0);
    expect(trail).toEqual([[0, 0]]);
  });

  it('merges collinear forward motion into one segment', () => {
    const trail: Point[] = [];
    appendTrailPoint(trail, 0, 0);
    appendTrailPoint(trail, 1, 1);
    appendTrailPoint(trail, 2, 2);
    appendTrailPoint(trail, 3, 3);
    expect(trail).toEqual([
      [0, 0],
      [3, 3],
    ]);
  });

  it('keeps a collinear reversal (backtracking is real geometry)', () => {
    const trail: Point[] = [];
    appendTrailPoint(trail, 0, 0);
    appendTrailPoint(trail, 2, 0);
    appendTrailPoint(trail, 1, 0);
    expect(trail).toEqual([
      [0, 0],
      [2, 0],
      [1, 0],
    ]);
  });

  it('keeps genuine turns', () => {
    const trail: Point[] = [];
    appendTrailPoint(trail, 0, 0);
    appendTrailPoint(trail, 1, 0);
    appendTrailPoint(trail, 1, 1);
    expect(trail).toHaveLength(3);
  });

  it('never produces consecutive duplicates, whatever the input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })), {
          maxLength: 60,
        }),
        (points) => {
          const trail: Point[] = [];
          for (const [x, y] of points) appendTrailPoint(trail, x, y);
          for (let i = 1; i < trail.length; i++) {
            expect(trail[i]).not.toEqual(trail[i - 1]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('snapWU', () => {
  it('snaps onto the 1e-7 lattice and keeps lattice values exact', () => {
    expect(snapWU(1.23456789)).toBe(1.2345679);
    expect(snapWU(200)).toBe(200);
    expect(snapWU(0.4499999999999999)).toBe(0.45);
  });

  it('flushes subnormals to zero (the verified clipper corruption trigger)', () => {
    expect(snapWU(1e-323)).toBe(0);
    expect(snapWU(5e-324)).toBe(0);
    expect(Object.is(snapWU(-1e-323), 0) || snapWU(-1e-323) === 0).toBe(true);
  });

  it('is idempotent for arbitrary inputs', () => {
    fc.assert(
      fc.property(fc.double({ min: -300, max: 300, noNaN: true }), (v) => {
        expect(snapWU(snapWU(v))).toBe(snapWU(v));
      }),
      { numRuns: 100 },
    );
  });
});

describe('validPolyTopology', () => {
  const outer = squareRing(5, 5, 5);

  it('accepts a poly without holes and with properly nested holes', () => {
    expect(validPolyTopology([outer])).toBe(true);
    expect(validPolyTopology([outer, squareRing(5, 5, 1)])).toBe(true);
  });

  it('accepts a hole touching the outer boundary at a vertex', () => {
    // Shares corner (0, 0) with the outer ring; the rest is strictly inside.
    expect(
      validPolyTopology([
        outer,
        [
          [0, 0],
          [2, 0.5],
          [0.5, 2],
        ],
      ]),
    ).toBe(true);
  });

  it('rejects a "hole" lying outside its outer ring (corrupt clipper output)', () => {
    expect(validPolyTopology([outer, squareRing(20, 20, 2)])).toBe(false);
  });

  it('rejects an empty poly', () => {
    expect(validPolyTopology([])).toBe(false);
  });
});

describe('squareRing / cloneTerritory', () => {
  it('builds a CCW square of the requested half-size', () => {
    const ring = squareRing(3, 4, 2);
    expect(ringArea(ring)).toBe(16);
    expect(pointInTerritory(3, 4, [[ring]])).toBe(true);
    expect(pointInTerritory(5.5, 4, [[ring]])).toBe(false);
  });

  it('deep-clones — mutating the clone leaves the original alone', () => {
    const original: Territory = [[squareRing(0, 0, 1)]];
    const clone = cloneTerritory(original);
    expect(clone).toEqual(original);
    const point = clone[0]?.[0]?.[0];
    if (!point) throw new Error('clone lost its shape');
    point[0] = 99;
    expect(original[0]?.[0]?.[0]?.[0]).toBe(-1);
  });
});
