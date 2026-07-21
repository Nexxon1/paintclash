import { BALANCE, type Point, type Territory } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { closeLoop } from './fill.js';
import { pointInTerritory, squareRing, territoryArea } from './geometry.js';

/** Own 6×6-ish block on (2..8)² — 36 WU². */
const ownSquare = (): Territory => [[squareRing(5, 5, 3)]];

describe('closeLoop', () => {
  it('captures the enclosed rectangle of a clean square loop', () => {
    // Exit right at (7,5), drive a rectangle, re-enter at (7,7). The chord
    // (7,7)→(7,5) closes inside the territory; enclosed = [7..12]×[5..10]
    // minus the 1×3 overlap with the own square = 25 − 3 = 22.
    const trail: Point[] = [
      [7, 5],
      [12, 5],
      [12, 10],
      [7, 10],
      [7, 7],
    ];
    const outcome = closeLoop(ownSquare(), trail, []);
    expect(outcome).not.toBeNull();
    expect(outcome?.gainedArea).toBeCloseTo(22, 6);
    expect(territoryArea(outcome?.territory ?? [])).toBeCloseTo(58, 6);
    // The captured pocket belongs to the player now …
    expect(pointInTerritory(10, 7, outcome?.territory ?? [])).toBe(true);
    // … and the old land still does.
    expect(pointInTerritory(3, 3, outcome?.territory ?? [])).toBe(true);
  });

  it('rejects a numerical sliver below the 1 WU² floor (spec §2.2)', () => {
    const trail: Point[] = [
      [7, 5],
      [8.4, 5.05],
      [7, 5.1],
    ];
    expect(closeLoop(ownSquare(), trail, [])).toBeNull();
  });

  it('rejects a trail too short to enclose anything', () => {
    expect(closeLoop(ownSquare(), [], [])).toBeNull();
    expect(
      closeLoop(
        ownSquare(),
        [
          [7, 5],
          [9, 5],
        ],
        [],
      ),
    ).toBeNull();
  });

  it('never captures foreign territory — the gain is clipped (ticket 06 changes this)', () => {
    // Enemy block adjacent to the loop area: the loop [7..12]×[5..10]
    // overlaps the enemy square (10..14)×(4..8) — that part is not captured.
    const enemy: Territory = [[squareRing(12, 6, 2)]];
    const trail: Point[] = [
      [7, 5],
      [12, 5],
      [12, 10],
      [7, 10],
      [7, 7],
    ];
    const outcome = closeLoop(ownSquare(), trail, [enemy]);
    expect(outcome).not.toBeNull();
    // Enemy overlap with the enclosed rect: x∈[10,12], y∈[5,8] = 6.
    expect(outcome?.gainedArea).toBeCloseTo(22 - 6, 6);
    expect(pointInTerritory(11, 6, outcome?.territory ?? [])).toBe(false);
  });

  it('encircling a foreign block yields an annulus — hole kept, heads survive by land', () => {
    const enemy: Territory = [[squareRing(15, 15, 2)]]; // (13..17)² = 16
    const trail: Point[] = [
      [7, 5],
      [25, 5],
      [25, 25],
      [5, 25],
      [5, 7],
    ];
    const outcome = closeLoop(ownSquare(), trail, [enemy]);
    expect(outcome).not.toBeNull();
    // Loop polygon 398, own overlap 7 → union 427; enemy carved back: −16.
    expect(territoryArea(outcome?.territory ?? [])).toBeCloseTo(411, 6);
    expect(outcome?.gainedArea).toBeCloseTo(375, 6);
    // Enclosed neutral land is captured, the enemy block is not.
    expect(pointInTerritory(10, 15, outcome?.territory ?? [])).toBe(true);
    expect(pointInTerritory(15, 15, outcome?.territory ?? [])).toBe(false);
  });

  it('captures pockets enclosed between loop and territory (hole-filling)', () => {
    // C-shaped own territory; the loop bridges the mouth → the notch becomes
    // enclosed neutral land and is captured along with the loop area.
    const c: Territory = [
      [
        [
          [0, 0],
          [10, 0],
          [10, 2],
          [2, 2],
          [2, 8],
          [10, 8],
          [10, 10],
          [0, 10],
        ],
      ],
    ];
    const trail: Point[] = [
      [9, 1],
      [12, 1],
      [12, 9],
      [9, 9],
    ];
    const outcome = closeLoop(c, trail, []);
    expect(outcome).not.toBeNull();
    // The notch interior is now owned.
    expect(pointInTerritory(6, 5, outcome?.territory ?? [])).toBe(true);
  });

  it('resolves a heavily self-overlapping spiral to its outer hull', () => {
    // Raw, this ring defeats polyclip ("unable to complete output ring",
    // ticket-04 spike); on the snap lattice it resolves cleanly instead.
    // Post-ticket-05 such players die at the first self-cut anyway.
    const spiral: Point[] = [];
    for (let i = 0; i < 2000; i++) {
      const t = (i / 300) * 2 * Math.PI;
      const r = 5 + (i % 600) / 60;
      spiral.push([50 + r * Math.cos(t), 50 + r * Math.sin(t)]);
    }
    const outcome = closeLoop([[squareRing(50, 50, 3)]], spiral, []);
    expect(outcome).not.toBeNull();
    // Outer hull of the spiral (radius ~12.2 disc) — far above the floor.
    expect(outcome?.gainedArea).toBeGreaterThan(400);
    expect(territoryArea(outcome?.territory ?? [])).toBeCloseTo(36 + (outcome?.gainedArea ?? 0), 6);
  });

  it('property: rectangle loops capture exactly their analytically enclosed area', () => {
    // Independent cross-check (ticket 04 §9.2: "vergrößert eigenes Gebiet ≥
    // eingeschlossene Fläche"): for an axis-aligned rectangle loop leaving
    // the (2..8)² square, the enclosed area has a closed form — no clipper
    // involved. Quarter-WU lattice keeps the family non-degenerate.
    const insideQ = fc.integer({ min: 9, max: 31 }); // /4 → 2.25 .. 7.75
    const outsideQ = fc.integer({ min: 34, max: 100 }); // /4 → 8.5 .. 25
    fc.assert(
      fc.property(insideQ, insideQ, insideQ, outsideQ, outsideQ, (sxq, syq, eyq, bxq, tyq) => {
        const [sx, sy, ey, bx, ty] = [sxq / 4, syq / 4, eyq / 4, bxq / 4, tyq / 4];
        const trail: Point[] = [
          [sx, sy],
          [bx, sy],
          [bx, ty],
          [sx, ty],
          [sx, ey],
        ];
        const outcome = closeLoop(ownSquare(), trail, []);
        // Loop = the rectangle [sx..bx]×[sy..ty]; its territory overlap is
        // the corner rectangle up to the square's edge at 8.
        const expected = (bx - sx) * (ty - sy) - (8 - sx) * (8 - sy);
        if (expected < BALANCE.trail.minFillAreaWU2) {
          expect(outcome).toBeNull();
        } else {
          expect(outcome?.gainedArea).toBeCloseTo(expected, 6);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('property: never throws, never shrinks, and any accepted gain ≥ the floor', () => {
    const coord = fc.double({ min: 0, max: 30, noNaN: true });
    fc.assert(
      fc.property(fc.array(fc.tuple(coord, coord), { minLength: 0, maxLength: 24 }), (rawTrail) => {
        const territory = ownSquare();
        const before = territoryArea(territory);
        const trail: Point[] = [[7, 5], ...rawTrail.map(([x, y]): Point => [x, y]), [5, 5]];
        const outcome = closeLoop(territory, trail, []);
        if (outcome) {
          expect(outcome.gainedArea).toBeGreaterThanOrEqual(BALANCE.trail.minFillAreaWU2);
          expect(territoryArea(outcome.territory)).toBeCloseTo(before + outcome.gainedArea, 6);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('property: with an enemy in the field, the gain never overlaps it', () => {
    const coord = fc.double({ min: 0, max: 30, noNaN: true });
    const enemy: Territory = [[squareRing(20, 20, 4)]];
    fc.assert(
      fc.property(fc.array(fc.tuple(coord, coord), { minLength: 1, maxLength: 16 }), (rawTrail) => {
        const trail: Point[] = [[7, 5], ...rawTrail.map(([x, y]): Point => [x, y]), [5, 5]];
        const outcome = closeLoop(ownSquare(), trail, [enemy]);
        if (outcome) {
          // Sample the enemy interior — none of it may have changed hands.
          for (const [x, y] of [
            [18, 18],
            [20, 20],
            [23.5, 23.5],
            [17, 23],
          ]) {
            expect(pointInTerritory(x ?? 0, y ?? 0, outcome.territory)).toBe(false);
          }
        }
      }),
      { numRuns: 150 },
    );
  });
});
