import type { Point, Territory } from '@paintclash/shared';
import { pointInTerritory, territoryArea } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

import {
  boundsOverlap,
  CARVE_WIDTH_WU,
  carveTerritory,
  PlateauCarver,
  pointsBounds,
  simplifyPolyline,
} from './carve.js';

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

  /**
   * The freeze of ticket 25, shrunk to its bones. Captured off a saturating
   * arena and then minimized: a three-vertex sliver of plateau and a trail
   * whose groove touches one of its corners EXACTLY. Fed to the clipper as
   * they come off the sim's floats, these numbers make the Martinez sweep
   * grind for **3,1 seconds** and then throw `unable to complete output ring`
   * — a frozen tab, and a groove that silently never appears (the throw is
   * caught, the uncarved shape kept). Six of these in five minutes of the
   * deployed build, the worst 4,4 s.
   *
   * Nothing here is big. That is the whole point: the trigger is a vertex
   * pair that misses by ~1e-12 WU, which is why the fix is the snap lattice
   * and not a smaller input.
   */
  it('carves geometry that makes the raw clipper grind and throw', () => {
    const sliver: Territory = [
      [
        [
          [112.91755193923235, 95.913400478644],
          [112.33826580758219, 95.76550453934293],
          [118.672796, 89.614237],
        ],
      ],
    ];
    const trail: Point[] = [
      [111.75176199366763, 96.23501173905039],
      [112.18777620877125, 96.34632932179258],
      [112.57621668847199, 96.57351645551688],
    ];
    const before = territoryArea(sliver);
    const carved = carveTerritory(sliver, [trail]);
    // The groove really was cut. Before the lattice this came back as the
    // untouched input — the clipper threw, and `carveTerritory` fell back.
    expect(territoryArea(carved)).toBeLessThan(before);
    expect(territoryArea(carved)).toBeGreaterThan(0);
  });
});

describe('simplifyPolyline', () => {
  it('collapses a densely sampled straight run to its endpoints', () => {
    const dense: Point[] = Array.from({ length: 101 }, (_, i) => [i * 0.1, 5]);
    expect(simplifyPolyline(dense, 0.1)).toEqual([
      [0, 5],
      [10, 5],
    ]);
  });

  it('keeps every dropped vertex within the tolerance of the result', () => {
    const dense: Point[] = Array.from({ length: 200 }, (_, i): Point => {
      const t = i * 0.1;
      return [t, 3 * Math.sin(t / 2)];
    });
    const simple = simplifyPolyline(dense, 0.1);
    expect(simple.length).toBeLessThan(dense.length / 3);
    for (const p of dense) {
      let best = Infinity;
      for (let i = 1; i < simple.length; i++) {
        const a = simple[i - 1];
        const b = simple[i];
        if (!a || !b) continue;
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const lengthSq = abx * abx + aby * aby;
        const t = Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (lengthSq || 1)),
        );
        best = Math.min(best, Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby));
      }
      expect(best).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('passes short polylines through as copies', () => {
    const two: Point[] = [
      [1, 2],
      [3, 4],
    ];
    const out = simplifyPolyline(two, 0.5);
    expect(out).toEqual(two);
    expect(out).not.toBe(two);
  });
});

describe('PlateauCarver (incremental grooves)', () => {
  const grow = (n: number): Point[] =>
    Array.from({ length: n }, (_, i): Point => [-2 + i * 0.45, 5 + Math.sin(i / 4)]);

  it('matches the one-shot carve when fed a trail point by point', () => {
    const trail = grow(40); // crosses the 10×10 plateau
    const carver = new PlateauCarver();
    carver.reset(plateau());
    let out: Territory = [];
    for (let n = 2; n <= trail.length; n++) {
      out = carver.update([{ playerId: 7, points: trail.slice(0, n) }]);
    }
    const oneShot = carveTerritory(plateau(), [trail]);
    expect(territoryArea(out)).toBeCloseTo(territoryArea(oneShot), 1);
    expect(pointInTerritory(5, 5 + Math.sin(15.5 / 4), out)).toBe(false);
  });

  it('returns the same reference while nothing changed — the caller skips its rebuild', () => {
    const carver = new PlateauCarver();
    carver.reset(plateau());
    const trail = grow(10);
    const first = carver.update([{ playerId: 7, points: trail }]);
    expect(carver.update([{ playerId: 7, points: trail }])).toBe(first);
    // A tip advancing less than the clip threshold changes nothing either.
    const nudged = [...trail.slice(0, -1), [trail[9]?.[0] ?? 0, (trail[9]?.[1] ?? 0) + 0.1]];
    expect(carver.update([{ playerId: 7, points: nudged as Point[] }])).toBe(first);
  });

  it('heals the groove when the trail ends, and recuts a restarted one', () => {
    const base = plateau();
    const carver = new PlateauCarver();
    carver.reset(base);
    carver.update([{ playerId: 7, points: grow(40) }]);
    // Trail gone (fill/death): the plateau heals back to the base.
    expect(carver.update([])).toBe(base);
    // A restarted (shorter) trail recuts from pristine.
    const fresh: Point[] = [
      [-2, 8],
      [12, 8],
    ];
    const recut = carver.update([{ playerId: 7, points: fresh }]);
    expect(pointInTerritory(5, 8, recut)).toBe(false);
    expect(pointInTerritory(5, 5, recut)).toBe(true);
  });

  it('reset adopts a new base and drops all groove memory', () => {
    const carver = new PlateauCarver();
    carver.reset(plateau());
    carver.update([{ playerId: 7, points: grow(40) }]);
    const next = plateau();
    carver.reset(next);
    expect(carver.update([])).toBe(next);
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
