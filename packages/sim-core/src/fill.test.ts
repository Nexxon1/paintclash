import { BALANCE, type Point, type Territory } from '@paintclash/shared';
import fc from 'fast-check';
import { difference, intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';

import { closeLoop } from './fill.js';
import { LATTICE_NOISE_WU2 } from './fixtures/tolerances.js';
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

  it('rejects a numerical sliver below the fill floor (spec §2.2)', () => {
    // A grazing re-entry enclosing ~0.0007 WU² beyond the own edge.
    const trail: Point[] = [
      [7, 5],
      [8.2, 5.02],
      [7, 5.04],
    ];
    expect(closeLoop(ownSquare(), trail, [])).toBeNull();
  });

  it('fills a deliberate shallow edge-hugging loop well under 1 WU² (user report)', () => {
    // Out 0.3 WU along the top edge, 2 WU sideways, back in: ~0.6 WU² of
    // "very small gap" — deliberate, so it must paint (spec §2.2: the floor
    // only drops numerical slivers; jeder bewusste Loop färbt).
    const trail: Point[] = [
      [4, 7.8],
      [4, 8.3],
      [6, 8.3],
      [6, 7.8],
    ];
    const outcome = closeLoop(ownSquare(), trail, []);
    expect(outcome).not.toBeNull();
    expect(outcome?.gainedArea).toBeCloseTo(0.6, 6);
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

  it('steals the enclosed slice of a foreign territory (spec §2.2, ticket 06)', () => {
    // Enemy block (10..14)×(4..8); the loop encloses [7..12]×[5..10] — the
    // overlap x∈[10,12], y∈[5,8] (6 WU²) changes hands.
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
    // The full enclosure counts, stolen land included: 25 − 3 own overlap.
    expect(outcome?.gainedArea).toBeCloseTo(22, 6);
    expect(pointInTerritory(11, 6, outcome?.territory ?? [])).toBe(true);
    // The enemy keeps exactly the un-enclosed remainder.
    expect(territoryArea(outcome?.others[0] ?? [])).toBeCloseTo(10, 6);
    expect(pointInTerritory(11, 6, outcome?.others[0] ?? [])).toBe(false);
    expect(pointInTerritory(13, 6, outcome?.others[0] ?? [])).toBe(true);
  });

  it('encircling a foreign block captures it whole — no annulus, the block changes hands', () => {
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
    // Loop polygon 398, own overlap 7 → union 427 — enclosed neutral land
    // AND the enclosed enemy block are captured (spec §2.2: überfärbt).
    expect(territoryArea(outcome?.territory ?? [])).toBeCloseTo(427, 6);
    expect(outcome?.gainedArea).toBeCloseTo(391, 6);
    expect(pointInTerritory(10, 15, outcome?.territory ?? [])).toBe(true);
    expect(pointInTerritory(15, 15, outcome?.territory ?? [])).toBe(true);
    // The enemy is left with nothing — the total-loss verdict is step's job.
    expect(outcome?.others[0]).toEqual([]);
  });

  it('returns a foreign territory untouched by the loop as the same reference', () => {
    // Bit-stable state for uninvolved players: no phantom hash change, no
    // pointless territory sync. Far away, so the bounding-box prefilter
    // (ticket 22) answers this without a clipper op at all.
    const enemy: Territory = [[squareRing(25, 25, 2)]];
    const trail: Point[] = [
      [7, 5],
      [12, 5],
      [12, 10],
      [7, 10],
      [7, 7],
    ];
    const outcome = closeLoop(ownSquare(), trail, [enemy]);
    expect(outcome).not.toBeNull();
    expect(outcome?.others[0]).toBe(enemy);
  });

  it('keeps the reference for an enemy whose BOX overlaps but whose land does not', () => {
    // The prefilter's other side: capture is [7..12]×[5..10], the enemy an
    // L around it whose bounding box covers the capture completely while its
    // land stays clear. The clipper runs, finds nothing to remove, and the
    // area check keeps the input reference — the outcome must not depend on
    // which of the two paths decided it.
    const enemy: Territory = [
      [
        [
          [13, 4],
          [15, 4],
          [15, 12],
          [6, 12],
          [6, 11],
          [13, 11],
        ],
      ],
    ];
    const trail: Point[] = [
      [7, 5],
      [12, 5],
      [12, 10],
      [7, 10],
      [7, 7],
    ];
    const outcome = closeLoop(ownSquare(), trail, [enemy]);
    expect(outcome).not.toBeNull();
    expect(outcome?.others[0]).toBe(enemy);
  });

  it('still steals from an enemy that only TOUCHES the capture box', () => {
    // Boxes flush against each other at x = 12 are NOT separated, so the op
    // runs — and here it must, because the loop's chord slices into the
    // enemy: [10..14]×[4..8] loses x∈[10,12], y∈[5,8].
    const enemy: Territory = [[squareRing(12, 6, 2)]];
    const trail: Point[] = [
      [7, 5],
      [12, 5],
      [12, 10],
      [7, 10],
      [7, 7],
    ];
    const outcome = closeLoop(ownSquare(), trail, [enemy]);
    expect(territoryArea(outcome?.others[0] ?? [])).toBeCloseTo(10, 6);
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

  it('steals foreign land out of a POCKET the loop merely encloses', () => {
    // The capture region is not just the loop: bridging the mouth of a
    // C-shaped territory turns the whole notch into owned land (spec §2.2),
    // and an enemy sitting in that notch loses it — even though the loop
    // itself never touches them.
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
    const enemyInNotch: Territory = [[squareRing(6, 5, 1)]];
    const trail: Point[] = [
      [9, 1],
      [12, 1],
      [12, 9],
      [9, 9],
    ];
    const outcome = closeLoop(c, trail, [enemyInNotch]);
    expect(outcome).not.toBeNull();
    expect(pointInTerritory(6, 5, outcome?.territory ?? [])).toBe(true);
    // Enclosed, so it changes hands entirely — the total-loss verdict.
    expect(outcome?.others[0]).toEqual([]);
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

  // The most expensive property in this file by an order of magnitude: every
  // case pays a fill PLUS two extra clipper ops per enemy to recompute the
  // definition being replaced. The explicit ceiling is the scenario suite's
  // rule 3 applied here — a slow shared runner must make this slower, not red
  // (it took 10,6 s on a CI runner against the 5 s default, at 0,8 s locally).
  it(
    'property: carving with the gained region equals carving with the whole capture',
    { timeout: 60_000 },
    () => {
      // The identity `gainedRegion` rests on, checked differentially against the
      // definition it replaced: whatever the filler ends up owning, every enemy
      // must come out exactly as `difference(other, captured)` would have left
      // them. The golden replay cannot guard this — it contains one fill and no
      // steal at all — so this property is the regression test for it.
      const coord = fc.double({ min: 9, max: 30, noNaN: true });
      // Enemy centres far enough out that a half-2 block clears the own (2..8)²
      // square: the identity needs enemy ∩ own OLD land = ∅, and a generator
      // that breaks the precondition tests nothing (verified — it fails, which
      // is the caveat `gainedRegion` documents, not a defect).
      const enemyCoord = fc.double({ min: 10.5, max: 30, noNaN: true });
      fc.assert(
        fc.property(
          fc.array(fc.tuple(coord, coord), { minLength: 1, maxLength: 8 }),
          fc.array(fc.tuple(enemyCoord, enemyCoord), { minLength: 1, maxLength: 2 }),
          (rawTrail, enemySpots) => {
            const enemies = enemySpots.map((spot): Territory => [
              [squareRing(spot[0], spot[1], 2)],
            ]);
            const trail: Point[] = [[7, 5], ...rawTrail.map(([x, y]): Point => [x, y]), [5, 5]];
            const outcome = closeLoop(ownSquare(), trail, enemies);
            if (!outcome) return;
            enemies.forEach((enemy, i) => {
              const viaGained = outcome.others[i] ?? [];
              // The definition this replaced, computed straight from the result.
              const viaCaptured = difference(enemy, outcome.territory) as Territory;
              const lostViaGained = territoryArea(enemy) - territoryArea(viaGained);
              const lostViaCaptured = territoryArea(enemy) - territoryArea(viaCaptured);
              expect(Math.abs(lostViaGained - lostViaCaptured)).toBeLessThan(LATTICE_NOISE_WU2);
              // Same land, not merely the same amount of it.
              expect(
                Math.abs(
                  territoryArea(intersection(viaGained, viaCaptured) as Territory) -
                    territoryArea(viaGained),
                ),
              ).toBeLessThan(LATTICE_NOISE_WU2);
            });
          },
        ),
        { numRuns: 120 },
      );
    },
  );

  it('property: stealing conserves land — the enemy loses exactly the overlap, stays disjoint', () => {
    const coord = fc.double({ min: 0, max: 30, noNaN: true });
    const enemy: Territory = [[squareRing(20, 20, 4)]];
    fc.assert(
      fc.property(fc.array(fc.tuple(coord, coord), { minLength: 1, maxLength: 16 }), (rawTrail) => {
        const trail: Point[] = [[7, 5], ...rawTrail.map(([x, y]): Point => [x, y]), [5, 5]];
        const outcome = closeLoop(ownSquare(), trail, [enemy]);
        if (outcome) {
          const after = outcome.others[0] ?? [];
          // Never grows, never negative.
          const lost = 64 - territoryArea(after);
          expect(lost).toBeGreaterThanOrEqual(-1e-6);
          // Filler and shrunken enemy stay pairwise disjoint — to lattice
          // scale. This used to be exactly 0: the loser was carved with the
          // very polygon the winner stores. Since ticket 22 the two are
          // compacted from different polygons, so they may overlap by
          // LATTICE_NOISE_WU2 (measured worst case 5,3e-7). The bound is
          // named rather than nudged, so a real disjointness break — which
          // would be orders larger — still fails here.
          expect(
            territoryArea(intersection(outcome.territory, after) as Territory),
          ).toBeLessThanOrEqual(LATTICE_NOISE_WU2);
          // … and the enemy lost exactly what the filler now holds of it.
          const overlap = territoryArea(intersection(outcome.territory, enemy));
          expect(lost).toBeCloseTo(overlap, 6);
        }
      }),
      { numRuns: 150 },
    );
  });
});
