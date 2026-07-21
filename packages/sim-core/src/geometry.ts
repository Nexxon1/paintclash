/**
 * Plane geometry over the shared polygon shapes (spec §2.2: polygon-based
 * fill, never splix' cell flood-fill). Pure float math, deterministic on any
 * IEEE-754 engine — exactly the determinism class ADR-0003 demands (internal,
 * not cross-machine bit-exact).
 *
 * Territories follow the even-odd rule: every ring flips containment, so an
 * outer ring plus a hole ring form an annulus without any winding bookkeeping.
 */

import type { Point, Ring, Territory } from '@paintclash/shared';

/**
 * Collinearity tolerance for trail compaction, as perpendicular distance in
 * WU. Sub-nanometer: it only eats float noise on exactly-straight runs and
 * never moves real geometry (a fill's area changes by < 1e-6 WU²).
 */
const COLLINEAR_EPS_WU = 1e-9;

/**
 * Boolean geometry runs on a fixed 1e-7 WU lattice (Clipper-style): every
 * coordinate entering or leaving the clipper is snapped. Near-coincident
 * float garbage collapses to *exact* coincidence — which the clipper handles
 * robustly — and subnormal doubles (a verified polyclip corruption trigger:
 * `difference` emitted a hole outside its outer ring) cannot occur at all.
 * 200 WU × 1e7 < 2^53, so the lattice is exact in doubles.
 */
const LATTICE_INV_WU = 1e7;

/** Snap one coordinate onto the boolean-geometry lattice. */
export function snapWU(value: number): number {
  return Math.round(value * LATTICE_INV_WU) / LATTICE_INV_WU;
}

/** Signed shoelace area of one ring — CCW positive, degenerate rings 0. */
export function ringArea(ring: Ring): number {
  let prev = ring[ring.length - 1];
  if (prev === undefined) return 0;
  let sum = 0;
  for (const curr of ring) {
    sum += prev[0] * curr[1] - curr[0] * prev[1];
    prev = curr;
  }
  return sum / 2;
}

/**
 * Total owned area: per piece, |outer ring| minus its |hole rings| — the
 * quantity behind the "areas + neutral = 100 %" invariant (spec §9.2).
 */
export function territoryArea(territory: Territory): number {
  let total = 0;
  for (const poly of territory) {
    poly.forEach((ring, i) => {
      total += (i === 0 ? 1 : -1) * Math.abs(ringArea(ring));
    });
  }
  return total;
}

/** Even-odd ray cast against one ring. */
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let prev = ring[ring.length - 1];
  if (prev === undefined) return false;
  let inside = false;
  for (const curr of ring) {
    const [xi, yi] = curr;
    const [xj, yj] = prev;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    prev = curr;
  }
  return inside;
}

/** Even-odd containment across all rings — holes flip back to "outside". */
export function pointInTerritory(x: number, y: number, territory: Territory): boolean {
  let inside = false;
  for (const poly of territory) {
    for (const ring of poly) {
      if (pointInRing(x, y, ring)) inside = !inside;
    }
  }
  return inside;
}

/** Squared distance from (x, y) to the segment a–b. */
function segmentDistanceSq(x: number, y: number, a: Point, b: Point): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lengthSq = abx * abx + aby * aby;
  let t = 0;
  if (lengthSq > 0) {
    t = Math.min(1, Math.max(0, ((x - a[0]) * abx + (y - a[1]) * aby) / lengthSq));
  }
  const dx = x - (a[0] + t * abx);
  const dy = y - (a[1] + t * aby);
  return dx * dx + dy * dy;
}

/**
 * Distance from a point to a territory: 0 inside, else the distance to the
 * nearest boundary edge; Infinity for an empty territory. Drives the spawn
 * minimum distance (spec §2.3) against arbitrarily grown territories.
 */
export function distanceToTerritory(x: number, y: number, territory: Territory): number {
  if (territory.length === 0) return Infinity;
  if (pointInTerritory(x, y, territory)) return 0;
  let best = Infinity;
  for (const poly of territory) {
    for (const ring of poly) {
      let prev = ring[ring.length - 1];
      if (prev === undefined) continue;
      for (const curr of ring) {
        best = Math.min(best, segmentDistanceSq(x, y, prev, curr));
        prev = curr;
      }
    }
  }
  return Math.sqrt(best);
}

/**
 * Append the head position to a trail polyline, in place. Exact duplicates
 * are dropped (head pinned against a wall) and *forward* collinear motion is
 * merged into one segment — straight runs stay O(1) points. A collinear
 * reversal is kept: backtracking is real geometry, not redundancy.
 */
export function appendTrailPoint(trail: Point[], x: number, y: number): void {
  const last = trail[trail.length - 1];
  if (last === undefined) {
    trail.push([x, y]);
    return;
  }
  if (last[0] === x && last[1] === y) return;
  const beforeLast = trail[trail.length - 2];
  if (beforeLast !== undefined) {
    const ax = last[0] - beforeLast[0];
    const ay = last[1] - beforeLast[1];
    const bx = x - last[0];
    const by = y - last[1];
    const cross = ax * by - ay * bx;
    const forward = ax * bx + ay * by > 0;
    // |cross| = perpendicular deviation × |previous segment| — segments are
    // ≤ 0.45 WU, so the eps stays a true sub-nanometer deviation bound.
    if (forward && Math.abs(cross) < COLLINEAR_EPS_WU) {
      last[0] = x;
      last[1] = y;
      return;
    }
  }
  trail.push([x, y]);
}

/**
 * Sanity check on clipper output: every hole ring must start inside its
 * outer ring. Violations mean corrupt topology — even-odd containment would
 * read such a "hole" as owned land (the exact failure the lattice guards
 * against); callers forfeit the operation instead of storing it.
 */
export function validPolyTopology(poly: Ring[]): boolean {
  const outer = poly[0];
  if (outer === undefined) return false;
  for (const hole of poly.slice(1)) {
    // A legal hole may *touch* the outer ring, where a ray cast is
    // ambiguous — but then its remaining vertices are strictly inside.
    // Corrupt output has the whole ring outside: no vertex passes.
    if (!hole.some(([x, y]) => pointInRing(x, y, outer))) return false;
  }
  return true;
}

/** Axis-aligned CCW square ring around (cx, cy) — the spawn start block. */
export function squareRing(cx: number, cy: number, half: number): Ring {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
}

/** Deep copy — clones and originals must never share point arrays. */
export function cloneTerritory(territory: Territory): Territory {
  return territory.map((poly) => poly.map((ring) => ring.map((p): Point => [p[0], p[1]])));
}
