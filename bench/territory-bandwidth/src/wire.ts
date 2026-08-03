/**
 * What a territory costs on the wire, and what decimating it for the send path
 * would save — the two quantities [ticket 29](../../../.scratch/paintclash/issues/29-gebiets-deltas-statt-vollbild.md)
 * asks for before anything is rebuilt.
 *
 * Everything here is a pure function of geometry, unit-tested next door. The
 * arena run that feeds it lives in `harness.ts`.
 */

import { simplifyPolyline } from '@paintclash/client/render/carve';
import { encodeTerritory } from '@paintclash/protocol';
import type { Point, Poly, Ring, Territory } from '@paintclash/shared';

/**
 * Bytes one territory frame puts on the wire.
 *
 * Measured through the REAL encoder rather than modelled from the vertex count:
 * the header, the per-poly and per-ring counts are part of what a client pays
 * for, and `bench/do-cpu` already showed what modelling the fill instead of
 * running it costs in credibility. The player id and reason do not affect the
 * size, so they are fixed here.
 */
export function territoryFrameBytes(territory: Territory): number {
  return encodeTerritory(0, 'fill', territory).length;
}

/** The fewest vertices that still bound an area. */
const MIN_RING_VERTICES = 3;

/**
 * Ramer–Douglas–Peucker over a CLOSED ring.
 *
 * `simplifyPolyline` (client/render/carve.ts) does the actual work; what this
 * adds is the ring's missing endpoints. A ring is implicitly closed
 * (`shared/types.ts`), so running RDP straight over its vertex array pins
 * `ring[0]` and `ring[n-1]` — the two vertices straddling the closing edge
 * become immune to simplification whatever the tolerance, which puts a floor
 * under the byte count this bench is trying to measure.
 *
 * The fix is the standard one: cut the ring at two anchors that no tolerance
 * would drop anyway, and simplify the two open halves between them. The first
 * anchor is the lexicographically smallest vertex — always on the convex hull,
 * so it survives any RDP, and picked by coordinate rather than by index so that
 * the result does not depend on where the clipper happened to start the ring.
 * The second is the vertex farthest from it.
 *
 * The returned ring starts at that first anchor, i.e. it is generally a
 * ROTATION of the input. For an implicitly closed ring that is not a change:
 * same vertices, same edges, same area, same frame size.
 */
export function simplifyRing(ring: Ring, epsilonWU: number): Ring {
  if (ring.length <= MIN_RING_VERTICES) return ring.map(clonePoint);
  const start = lexicographicallySmallest(ring);
  const rotated = [...ring.slice(start), ...ring.slice(0, start)];
  const far = farthestFrom(rotated, 0);
  // Every vertex identical: there is no second anchor, and nothing to drop.
  if (far < 1) return ring.map(clonePoint);
  const head = simplifyPolyline(rotated.slice(0, far + 1), epsilonWU);
  const tailPoints = rotated.slice(far);
  const first = rotated[0];
  if (first !== undefined) tailPoints.push(first);
  const tail = simplifyPolyline(tailPoints, epsilonWU);
  // `head` ends on the far anchor and `tail` begins on it; `tail` ends on the
  // first anchor that `head` begins with. Dropping each half's last vertex
  // leaves the ring closed exactly once.
  return [...head.slice(0, -1), ...tail.slice(0, -1)];
}

/**
 * One piece, decimated to `epsilonWU` — or `null` when the tolerance erased it.
 *
 * Rings that collapse below a triangle are dropped rather than shipped: a
 * two-vertex "ring" is not a polygon, and the wire format would carry it
 * happily for the renderer to choke on. A collapsed OUTER ring takes its whole
 * piece with it, holes included, and that is what `null` reports.
 */
export function simplifyPoly(poly: Poly, epsilonWU: number): Poly | null {
  const rings: Poly = [];
  for (const ring of poly) {
    const next = simplifyRing(ring, epsilonWU);
    // A collapsed outer ring ends the piece; a collapsed hole just goes.
    if (next.length < MIN_RING_VERTICES) {
      if (rings.length === 0) return null;
      continue;
    }
    rings.push(next);
  }
  return rings.length > 0 ? rings : null;
}

/**
 * A decimation with its two effects kept apart: pieces whose outline MOVED, and
 * pieces that were ERASED.
 *
 * Separating them is not bookkeeping tidiness, it is the difference between a
 * usable estimate and a misleading one. Measured together — every original
 * vertex against whatever survived — a saturated arena reports an outline
 * "deviation" of nearly two grid squares for a tolerance of a twentieth of a
 * trail width, because the number is really the distance from a far-off erased
 * splinter to the nearest surviving land, not any outline that moved. Erasing a
 * piece and moving an outline are different events with different costs, and one
 * number cannot say both. The measured before/after is in this bench's README.
 */
export interface SimplifyOutcome {
  simplified: Territory;
  /** Surviving pieces paired with their originals, for outline comparison. */
  kept: { before: Poly; after: Poly }[];
  /** Pieces the tolerance erased, as their originals — measure what was lost. */
  lost: Poly[];
}

export function simplifyTerritoryDetailed(
  territory: Territory,
  epsilonWU: number,
): SimplifyOutcome {
  const simplified: Territory = [];
  const kept: { before: Poly; after: Poly }[] = [];
  const lost: Poly[] = [];
  for (const poly of territory) {
    const after = simplifyPoly(poly, epsilonWU);
    if (after === null) {
      lost.push(poly);
      continue;
    }
    simplified.push(after);
    kept.push({ before: poly, after });
  }
  return { simplified, kept, lost };
}

/**
 * The largest distance, in WU, from any vertex of `before` to the boundary of
 * `after` — "how far did this piece's outline move?", which is what a player
 * can actually see.
 *
 * Per PIECE, against its own simplified self, so the answer is about an outline
 * and not about which pieces survived (see `SimplifyOutcome`).
 *
 * Deliberately not `distanceToTerritory` from sim-core: that reports 0 for
 * points inside the shape, so a cut corner — the very artefact decimation
 * produces — would score as a perfect match.
 *
 * Read next to the area error, not instead of it: this is the worst single
 * place on one piece, and one bad corner is a different complaint from a
 * uniformly shaved outline.
 */
export function polyDeviationWU(before: Poly, after: Poly): number {
  let worst = 0;
  for (const ring of before) {
    for (const point of ring) {
      worst = Math.max(worst, distanceToBoundary(point, after));
    }
  }
  return worst;
}

/** Distance from a point to the nearest edge of any ring — never 0 for inside. */
function distanceToBoundary(point: Point, poly: Poly): number {
  let best = Infinity;
  for (const ring of poly) {
    let prev = ring[ring.length - 1];
    if (prev === undefined) continue;
    for (const curr of ring) {
      best = Math.min(best, segmentDistanceSq(point, prev, curr));
      prev = curr;
    }
  }
  return Math.sqrt(best);
}

/** Squared distance from `p` to the segment a–b. */
function segmentDistanceSq(p: Point, a: Point, b: Point): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lengthSq = abx * abx + aby * aby;
  let t = 0;
  if (lengthSq > 0) {
    t = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lengthSq));
  }
  const dx = p[0] - (a[0] + t * abx);
  const dy = p[1] - (a[1] + t * aby);
  return dx * dx + dy * dy;
}

/**
 * Index of the smallest vertex by (x, then y). A hull vertex by construction,
 * so RDP keeps it at any tolerance — and chosen by coordinate, so two rings
 * describing the same outline anchor at the same corner.
 */
function lexicographicallySmallest(ring: Ring): number {
  let best = 0;
  let bestPoint = ring[0];
  if (bestPoint === undefined) return 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i];
    if (p === undefined) continue;
    if (p[0] < bestPoint[0] || (p[0] === bestPoint[0] && p[1] < bestPoint[1])) {
      best = i;
      bestPoint = p;
    }
  }
  return best;
}

/** Index of the vertex farthest from `ring[from]`, or 0 if none is. */
function farthestFrom(ring: Ring, from: number): number {
  const origin = ring[from];
  if (origin === undefined) return 0;
  let best = 0;
  let bestDistSq = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (p === undefined) continue;
    const dx = p[0] - origin[0];
    const dy = p[1] - origin[1];
    const distSq = dx * dx + dy * dy;
    if (distSq > bestDistSq) {
      bestDistSq = distSq;
      best = i;
    }
  }
  return best;
}

function clonePoint(p: Point): Point {
  return [p[0], p[1]];
}
