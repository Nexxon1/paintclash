import type { Point, Ring, Territory } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  appendTrailPoint,
  boundsSeparated,
  cloneTerritory,
  distanceToTerritory,
  pointInTerritory,
  polylineBand,
  ringArea,
  segmentDistanceSq,
  segmentsProperlyCross,
  snapWU,
  squareRing,
  territoryArea,
  territoryBounds,
  validPolyTopology,
  type Bounds,
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

describe('segmentsProperlyCross', () => {
  it('is true for a transversal X crossing', () => {
    expect(segmentsProperlyCross([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    // Order of the two segments cannot matter.
    expect(segmentsProperlyCross([0, 10], [10, 0], [0, 0], [10, 10])).toBe(true);
  });

  it('is false for a shared endpoint — two consecutive trail segments', () => {
    // The whole point of "proper": a polyline meeting itself at the joint it
    // was built from is not a crossing, however sharp the corner.
    expect(segmentsProperlyCross([0, 0], [5, 0], [5, 0], [5, 5])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [5, 0], [5, 0], [0, 0.001])).toBe(false);
  });

  it('is false when an endpoint merely touches the other segment (T shape)', () => {
    // The head arriving exactly ON its own line touches without passing
    // through — the wall clamp produces exactly this.
    expect(segmentsProperlyCross([5, 5], [5, 0], [0, 0], [10, 0])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [10, 0], [5, 5], [5, 0])).toBe(false);
  });

  it('is false for collinear segments, overlapping or not', () => {
    // Driving back along the own line (the pinned wall slide) overlaps
    // without ever crossing it.
    expect(segmentsProperlyCross([0, 0], [10, 0], [8, 0], [2, 0])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [4, 0], [6, 0], [10, 0])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [10, 0], [0, 0], [10, 0])).toBe(false);
  });

  it('is false for segments that miss each other', () => {
    expect(segmentsProperlyCross([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false);
    // Their infinite lines cross — the segments do not reach.
    expect(segmentsProperlyCross([0, 0], [4, 0], [5, -5], [5, 5])).toBe(false);
  });

  it('is false for a degenerate (zero-length) segment, even sitting on the other', () => {
    // A wall-pinned head does not move at all: its movement segment is a
    // point, which can never cross anything.
    expect(segmentsProperlyCross([5, 0], [5, 0], [0, 0], [10, 0])).toBe(false);
    expect(segmentsProperlyCross([5, 1], [5, 1], [0, 0], [10, 0])).toBe(false);
  });

  it('is symmetric in both arguments and both endpoint orders', () => {
    const coord = fc.integer({ min: -5, max: 5 });
    const point = fc.tuple(coord, coord).map(([x, y]): Point => [x, y]);
    fc.assert(
      fc.property(point, point, point, point, (a1, a2, b1, b2) => {
        const crosses = segmentsProperlyCross(a1, a2, b1, b2);
        expect(segmentsProperlyCross(b1, b2, a1, a2)).toBe(crosses);
        expect(segmentsProperlyCross(a2, a1, b1, b2)).toBe(crosses);
        expect(segmentsProperlyCross(a1, a2, b2, b1)).toBe(crosses);
      }),
      { numRuns: 200 },
    );
  });

  it('never reports a crossing where an endpoint sits on the other segment', () => {
    // A *proper* crossing meets in both interiors, so no endpoint of either
    // segment lies on the other one — the exact property the wall cases rely
    // on. (The converse does not hold: touching and collinear overlap put an
    // endpoint at distance 0 without being a crossing.)
    const coord = fc.integer({ min: -4, max: 4 });
    const point = fc.tuple(coord, coord).map(([x, y]): Point => [x, y]);
    fc.assert(
      fc.property(point, point, point, point, (a1, a2, b1, b2) => {
        if (!segmentsProperlyCross(a1, a2, b1, b2)) return;
        const onOtherSegment = Math.min(
          segmentDistanceSq(a1[0], a1[1], b1, b2),
          segmentDistanceSq(a2[0], a2[1], b1, b2),
          segmentDistanceSq(b1[0], b1[1], a1, a2),
          segmentDistanceSq(b2[0], b2[1], a1, a2),
        );
        expect(onOtherSegment).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('is false where a segment passes exactly through the other’s endpoint', () => {
    // The flip side of "proper", and the one degeneracy that is systematic
    // rather than a float coincidence: the wall clamp puts trail vertices
    // exactly on the wall line a pinned head slides along. Pinned by this
    // test so the next reader knows it is a decision — see the wall cases in
    // death.test.ts for why the wall is also the one place it is harmless.
    expect(segmentsProperlyCross([0, 0], [10, 0], [5, 0], [5, -5])).toBe(false);
    expect(segmentsProperlyCross([0, 0], [10, 0], [2, -3], [5, 0])).toBe(false);
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

describe('polylineBand', () => {
  it('wraps each segment in a rectangle of exactly the asked width', () => {
    const band = polylineBand(
      [
        [1, 1],
        [5, 1],
      ],
      0.25,
    );
    expect(band).toHaveLength(1);
    // 4 long, 0.5 wide, CCW like every other ring geometry.ts builds.
    expect(ringArea(band[0] ?? [])).toBeCloseTo(2, 9);
    expect(band[0]).toEqual([
      [1, 0.75],
      [5, 0.75],
      [5, 1.25],
      [1, 1.25],
    ]);
  });

  it('straddles the polyline — the band covers both of its sides', () => {
    const band = polylineBand(
      [
        [1, 1],
        [5, 1],
      ],
      0.25,
    );
    const asTerritory: Territory = band.map((ring) => [ring]);
    expect(pointInTerritory(3, 1.1, asTerritory)).toBe(true);
    expect(pointInTerritory(3, 0.9, asTerritory)).toBe(true);
    expect(pointInTerritory(3, 1.5, asTerritory)).toBe(false);
  });

  it('gives one rectangle per segment, overlapping at the joints', () => {
    const band = polylineBand(
      [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
      0.5,
    );
    expect(band).toHaveLength(2);
    // Both rectangles cover the joint's neighborhood, so their union is one
    // connected band — nothing to leak through at the corner.
    const asTerritory: Territory = band.map((ring) => [ring]);
    expect(pointInRingCount(3.9, 0.1, band)).toBe(2);
    expect(pointInTerritory(4.4, 2, asTerritory)).toBe(true);
  });

  it('skips zero-length segments — coincident points yield no rectangles', () => {
    expect(
      polylineBand(
        [
          [2, 2],
          [2, 2],
          [2, 2],
        ],
        0.5,
      ),
    ).toEqual([]);
    expect(polylineBand([[2, 2]], 0.5)).toEqual([]);
    expect(polylineBand([], 0.5)).toEqual([]);
  });

  it('survives the snap lattice at the width the fill actually uses', () => {
    // 1e-6 WU half-width on a 1e-7 lattice: whatever the segment's direction,
    // the offset's larger component is ≥ 7e-7, so snapping can never flatten
    // a rectangle along its width (`polylineBand`'s √2-cell precondition).
    // Any direction, any length a tick could produce — a tick moves 0.45 WU,
    // and a folded straight run is as long as the excursion was.
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0.01, max: 200, noNaN: true }),
        (angle, length) => {
          const a: Point = [100, 100];
          const b: Point = [100 + Math.cos(angle) * length, 100 + Math.sin(angle) * length];
          const band = polylineBand([a, b], 1e-6);
          const area = Math.abs(ringArea(band[0] ?? []));
          // Never flat: a flat band seals nothing, which is the whole point.
          expect(area).toBeGreaterThan(0);
          // Thickness = area / length, within one lattice cell of 2e-6.
          const thickness = area / Math.hypot(b[0] - a[0], b[1] - a[1]);
          expect(thickness).toBeGreaterThan(2e-6 - 1e-7);
          expect(thickness).toBeLessThan(2e-6 + 1e-7);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('yields nothing for a segment shorter than the lattice', () => {
    // Below 1e-7 WU the two endpoints ARE the same point, so there is no
    // segment to lay a rectangle along — and a flat ring would be a band that
    // seals nothing while looking like one.
    expect(
      polylineBand(
        [
          [100, 100],
          [100, 100 + 1e-9],
        ],
        1e-6,
      ),
    ).toEqual([]);
  });
});

/** In how many of the rings does the point sit? (Joint-overlap probe.) */
function pointInRingCount(x: number, y: number, rings: readonly Ring[]): number {
  return rings.filter((ring) => pointInTerritory(x, y, [[ring]])).length;
}

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

describe('territoryBounds / boundsSeparated', () => {
  it('spans every piece of a territory', () => {
    expect(territoryBounds([[squareRing(5, 5, 3)], [squareRing(20, 1, 1)]])).toEqual([2, 0, 21, 8]);
  });

  it('yields the empty (inverted) box for a territory that owns nothing', () => {
    const empty: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
    expect(territoryBounds([])).toEqual(empty);
    expect(territoryBounds([[]])).toEqual(empty);
    // Empty means "separated from everything" — the answer a caller needs,
    // and the reason this is total instead of nullable.
    const land = territoryBounds([[squareRing(5, 5, 3)]]);
    expect(boundsSeparated(territoryBounds([]), land)).toBe(true);
    expect(boundsSeparated(land, territoryBounds([]))).toBe(true);
    expect(boundsSeparated(territoryBounds([]), territoryBounds([]))).toBe(true);
  });

  it('ignores hole rings — a hole cannot reach past its outer ring', () => {
    const withHole: Territory = [[squareRing(5, 5, 3), squareRing(5, 5, 1)]];
    expect(territoryBounds(withHole)).toEqual(territoryBounds([[squareRing(5, 5, 3)]]));
  });

  it('separates boxes with a gap, in either order and on either axis', () => {
    const left = territoryBounds([[squareRing(0, 0, 1)]]);
    const right = territoryBounds([[squareRing(10, 0, 1)]]);
    const above = territoryBounds([[squareRing(0, 10, 1)]]);
    expect(boundsSeparated(left, right)).toBe(true);
    expect(boundsSeparated(right, left)).toBe(true);
    expect(boundsSeparated(left, above)).toBe(true);
    expect(boundsSeparated(above, left)).toBe(true);
  });

  it('does NOT separate overlapping or merely touching boxes', () => {
    const a = territoryBounds([[squareRing(0, 0, 1)]]);
    const overlapping = territoryBounds([[squareRing(1, 0, 1)]]);
    // Touching along x = 1: no shared area, but the conservative answer is
    // "run the clip" — nothing downstream may depend on the fast path.
    const touching = territoryBounds([[squareRing(2, 0, 1)]]);
    expect(boundsSeparated(a, overlapping)).toBe(false);
    expect(boundsSeparated(a, touching)).toBe(false);
  });

  it('property: separated boxes never contain a common point', () => {
    const coord = fc.double({ min: -50, max: 50, noNaN: true });
    fc.assert(
      fc.property(coord, coord, coord, coord, coord, coord, (ax, ay, bx, by, px, py) => {
        const a = territoryBounds([[squareRing(ax, ay, 2)]]);
        const b = territoryBounds([[squareRing(bx, by, 3)]]);
        if (!boundsSeparated(a, b)) return;
        const inA = px >= a[0] && px <= a[2] && py >= a[1] && py <= a[3];
        const inB = px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3];
        expect(inA && inB).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
