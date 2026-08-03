import type { Ring, Territory } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import {
  polyDeviationWU,
  simplifyRing,
  simplifyTerritoryDetailed,
  territoryFrameBytes,
} from './wire.js';

/** The decimated territory alone — what the send path would actually encode. */
const simplifyTerritory = (territory: Territory, epsilonWU: number): Territory =>
  simplifyTerritoryDetailed(territory, epsilonWU).simplified;

/**
 * The arithmetic this bench's numbers rest on, checked in milliseconds instead
 * of inside a multi-hour arena run — the rule from the tracker README ("wo eine
 * Prämisse gerechnet wird, gehört die Rechnung als reine Funktion nach `lib/`
 * mit eigenen Unit-Tests"). A wrong byte count or a simplification that
 * silently keeps every vertex would otherwise show up only as a table nobody
 * can tell apart from a correct one.
 */

/** A closed unit square, listed CCW from the origin. Four corners, no seam. */
const SQUARE: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('territoryFrameBytes', () => {
  /**
   * Pinned against the wire layout `encodeTerritory` documents — 5 header bytes
   * (opcode + u16 player + reason + u8 poly count), then per poly a u8 ring
   * count, then per ring a u16 point count and two float32 per point.
   *
   * Deliberately hand-computed rather than compared against the encoder's own
   * output: the implementation IS a call to that encoder, so comparing the two
   * would asssert nothing. This asserts that the encoder's frame is the thing
   * being counted, header included.
   */
  it('counts the documented territory frame layout', () => {
    expect(territoryFrameBytes([[SQUARE]])).toBe(5 + 1 + 2 + 4 * 8);
  });

  it('counts a two-piece territory with a hole', () => {
    const territory: Territory = [[SQUARE, SQUARE], [SQUARE]];
    expect(territoryFrameBytes(territory)).toBe(5 + (1 + 2 * (2 + 4 * 8)) + (1 + (2 + 4 * 8)));
  });

  /**
   * A dead player owns nothing, and the arena still sends the frame that says
   * so (`sync` on death, spec §6.1). Five bytes is the floor every egress
   * number here is measured against.
   */
  it('counts the empty territory as the bare header', () => {
    expect(territoryFrameBytes([])).toBe(5);
  });
});

describe('simplifyRing', () => {
  it('drops vertices within the tolerance of the chord they sit on', () => {
    const dense: Ring = [
      [0, 0],
      [5, 0.01],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(simplifyRing(dense, 0.1)).toEqual(SQUARE);
  });

  /**
   * The reason this function exists instead of a direct call to the client's
   * `simplifyPolyline`.
   *
   * A ring is implicitly closed (`shared/types.ts`: "last vertex ≠ first"), so
   * it has no endpoints — but RDP does, and it pins both of them. Run straight
   * over a ring's vertex array, it can never drop `ring[0]` or `ring[n-1]`,
   * whatever the tolerance: the two vertices that happen to straddle the
   * closing edge are immune. Here the redundant vertex IS `ring[0]`, exactly
   * collinear between its two neighbours, and a plain polyline RDP keeps it.
   *
   * The measurement cares because a per-ring floor of two immune vertices is a
   * per-ring floor on the byte count — small per ring, and this bench counts
   * hundreds of rings per frame.
   */
  it('drops a redundant vertex that sits at the ring seam', () => {
    const seamed: Ring = [
      [5, 0], // collinear between [0,0] (the last vertex) and [10,0]
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const simplified = simplifyRing(seamed, 0.1);
    expect(
      simplified.length,
      `the seam vertex survived: ${JSON.stringify(simplified)} — a ring RDP anchored on ` +
        `ring[0] cannot drop it, which is the bug this function exists to avoid`,
    ).toBe(4);
    // Rotation is meaningless for an implicitly closed ring, so the corners are
    // compared as a set-like sorted list rather than in the input's order.
    expect([...simplified].sort()).toEqual(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ].sort(),
    );
  });

  /**
   * Three vertices are the fewest that still bound an area. Simplifying below
   * that would turn land into a line — the caller (`simplifyPoly`) decides what
   * to do with a piece that thin, and it can only decide if this function does
   * not quietly produce one.
   */
  it('leaves a triangle alone however coarse the tolerance', () => {
    const triangle: Ring = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    expect(simplifyRing(triangle, 100)).toEqual(triangle);
  });

  it('keeps a ring whose every vertex is a real corner', () => {
    expect(simplifyRing(SQUARE, 0.1)).toHaveLength(4);
  });
});

describe('simplifyTerritory', () => {
  it('simplifies outer rings and holes alike', () => {
    const withBump = (scale: number): Ring => [
      [0, 0],
      [5 * scale, 0.01],
      [10 * scale, 0],
      [10 * scale, 10 * scale],
      [0, 10 * scale],
    ];
    const simplified = simplifyTerritory([[withBump(1), withBump(0.5)]], 0.1);
    expect(simplified[0]?.[0]).toHaveLength(4);
    expect(simplified[0]?.[1]).toHaveLength(4);
  });

  /**
   * A tolerance coarse enough to collapse a piece's outer ring below three
   * vertices has erased that piece. Dropping it is the honest outcome — a
   * two-vertex "ring" is not a polygon and `encodeTerritory` would happily put
   * it on the wire for the client to fail to tessellate. That the land is gone
   * is not hidden: it lands in the area error this bench reports next to the
   * byte saving.
   */
  it('drops a piece whose outer ring collapses', () => {
    const sliver: Ring = [
      [0, 0],
      [10, 0],
      [10, 0.001],
      [0, 0.001],
    ];
    expect(simplifyTerritory([[sliver]], 1)).toEqual([]);
  });

  it('drops a collapsed hole but keeps the piece around it', () => {
    const hole: Ring = [
      [1, 1],
      [2, 1],
      [2, 1.0001],
      [1, 1.0001],
    ];
    expect(simplifyTerritory([[SQUARE, hole]], 1)).toEqual([[SQUARE]]);
  });
});

describe('simplifyTerritoryDetailed', () => {
  /**
   * The split that keeps this bench's table honest: a piece whose outline moved
   * and a piece that was erased are different events, and a single "deviation"
   * number cannot report both — measured together, a saturated arena reports a
   * deviation orders of magnitude past its own tolerance, because the number is
   * really the distance from an erased splinter to the nearest surviving land.
   * The measured before/after is in the README, not here.
   */
  it('pairs survivors with their originals and hands back what it erased', () => {
    const sliver: Ring = [
      [50, 0],
      [60, 0],
      [60, 0.001],
      [50, 0.001],
    ];
    const outcome = simplifyTerritoryDetailed([[SQUARE], [sliver]], 1);
    expect(outcome.simplified).toEqual([[SQUARE]]);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.kept[0]?.before).toEqual([SQUARE]);
    expect(outcome.kept[0]?.after).toEqual([SQUARE]);
    expect(
      outcome.lost,
      'the erased sliver was not reported as lost, so the sweep would score it as a free ' +
        'byte saving with no cost beside it',
    ).toEqual([[sliver]]);
  });

  it('reports no losses when every piece survives', () => {
    const outcome = simplifyTerritoryDetailed([[SQUARE]], 0.1);
    expect(outcome.lost).toEqual([]);
    expect(outcome.kept).toHaveLength(1);
  });
});

describe('polyDeviationWU', () => {
  /**
   * The metric that answers "would a player see it?". Distance from every
   * ORIGINAL vertex to the simplified boundary — not `distanceToTerritory`,
   * which reports 0 for anything inside the shape and would therefore score a
   * cut corner as a perfect match.
   */
  it('is zero when nothing was dropped', () => {
    expect(polyDeviationWU([SQUARE], [SQUARE])).toBe(0);
  });

  it('reports how far the dropped vertex stood off the new boundary', () => {
    const bumped: Ring = [
      [0, 0],
      [5, 0.25],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polyDeviationWU([bumped], [SQUARE])).toBeCloseTo(0.25, 6);
  });

  /**
   * The whole reason this is not `distanceToTerritory`: a vertex that ends up
   * INSIDE the simplified shape still moved, and must not read as 0. Here the
   * dropped notch tip sits deep inside the square — 4,5 WU from its nearest
   * edge, the top one — and that is what a player would see disappear.
   */
  it('scores a vertex swallowed by the new outline by how far the outline moved', () => {
    const notched: Ring = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 5.5],
      [0, 10],
    ];
    expect(polyDeviationWU([notched], [SQUARE])).toBeCloseTo(4.5, 6);
  });
});
