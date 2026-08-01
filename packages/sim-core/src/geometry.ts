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
export function segmentDistanceSq(x: number, y: number, a: Point, b: Point): number {
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
 * Twice the signed area of the triangle p→q→r: positive when r lies left of
 * p→q, negative right of it, 0 when the three are collinear.
 */
function orient(p: Point, q: Point, r: Point): number {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

/** Do c and d lie on strictly opposite sides of the line a→b? */
function straddles(a: Point, b: Point, c: Point, d: Point): boolean {
  return Math.sign(orient(a, b, c)) * Math.sign(orient(a, b, d)) < 0;
}

/**
 * Do the segments a1–a2 and b1–b2 cross *transversally* — each strictly
 * straddling the other's line, so they share an interior point and pass
 * through each other?
 *
 * Deliberately narrower than "do they intersect" (ticket 19): everything
 * degenerate answers **false**, and each exclusion is a gameplay rule, not a
 * numerical convenience —
 *
 * - **Shared endpoint:** consecutive trail segments meet at the joint they
 *   were built from, and a tick's movement segment starts where the trail's
 *   tip is glued to the head. Neither is a self-cut.
 * - **Touching (T shape):** an endpoint landing exactly ON the other segment
 *   without passing through.
 * - **Collinear:** overlapping or not — a head sliding back along its own
 *   wall trail overlaps it without ever crossing it.
 * - **Zero length:** a head pinned in a corner does not move at all; a point
 *   crosses nothing.
 *
 * Three of those four hinge on an orientation being *exactly* 0, which no
 * tolerance is doing for us — the coordinates make it exact. A shared endpoint
 * is the identical pair of floats, so its two difference terms are both 0; and
 * the soft barrier's clamp (spec §2.4) writes the wall coordinate itself, so
 * every point pinned against a wall carries bit-identical x (or y) and the
 * wall line is exactly collinear with itself. Away from walls, an exact hit on
 * a segment's *interior* endpoint stays the float coincidence it is — which is
 * also why the WALL is the one place where this predicate's vertex blindness
 * is systematic, and the one place it is also right: nothing can reach the far
 * side of a wall, so a trail touching it has no far side to be crossed to.
 *
 * Symmetric in both arguments and in each segment's endpoint order.
 */
export function segmentsProperlyCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  return straddles(b1, b2, a1, a2) && straddles(a1, a2, b1, b2);
}

/**
 * Distance from a point to a territory: 0 inside, else the distance to the
 * nearest boundary edge; Infinity for an empty territory. Drives the spawn
 * minimum distance (spec §2.3) against arbitrarily grown territories, and on
 * the client how far clear of its own land a head has to get for its ribbon to
 * be drawn while its loop closes are earning nothing (ticket 20).
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
 * A band of the given half-width around a polyline: one rectangle per segment,
 * offset to both sides of it, everything on the snap lattice.
 *
 * The rectangles are returned loose, one ring each, and are meant to be handed
 * to the clipper together (as separate polygons of one multipolygon): at every
 * joint the two adjacent rectangles overlap around the shared point, so their
 * union is one connected band — no mitering, no join cases, and nothing that
 * could leave a gap for a fill to leak through. A convex joint's outer corner
 * is left un-filled, which is a notch of the band's own width, i.e. of the
 * order this band exists to stay below.
 *
 * Every rectangle returned has real area, so a caller may take the band's
 * presence as a seal. Two things earn that: points that coincide ON THE
 * LATTICE contribute no segment at all (so a polyline of near-identical poses
 * yields nothing rather than flat rings), and `halfWidthWU` must stay above √2
 * lattice cells, which keeps the offset's larger component at least one cell
 * wide however the segment is angled. Callers choose the width (see `fill.ts`);
 * this function only promises the band is as thick as asked, to lattice
 * resolution.
 */
export function polylineBand(points: readonly Point[], halfWidthWU: number): Ring[] {
  const band: Ring[] = [];
  let a: Point | undefined;
  for (const raw of points) {
    const b: Point = [snapWU(raw[0]), snapWU(raw[1])];
    const dx = a === undefined ? 0 : b[0] - a[0];
    const dy = a === undefined ? 0 : b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (a !== undefined && length > 0) {
      // Left normal, scaled to the half-width; right side first keeps the
      // rectangle CCW like every other ring this module builds.
      const nx = (-dy / length) * halfWidthWU;
      const ny = (dx / length) * halfWidthWU;
      band.push([
        [snapWU(a[0] - nx), snapWU(a[1] - ny)],
        [snapWU(b[0] - nx), snapWU(b[1] - ny)],
        [snapWU(b[0] + nx), snapWU(b[1] + ny)],
        [snapWU(a[0] + nx), snapWU(a[1] + ny)],
      ]);
    }
    a = b;
  }
  return band;
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

/** Axis-aligned bounding box `[minX, minY, maxX, maxY]`. */
export type Bounds = readonly [number, number, number, number];

/**
 * Axis-aligned bounds of a territory. Only OUTER rings are walked: a hole
 * lies inside its outer ring by definition (`validPolyTopology`), so it can
 * never widen the box.
 *
 * A territory owning nothing yields the INVERTED box (`min = +∞`,
 * `max = −∞`), which is the empty box rather than a missing one: it contains
 * no point and `boundsSeparated` reports it as separated from everything —
 * both exactly true of a player with no land. Total on purpose, so callers
 * carry no null case for a question that always has an answer.
 */
export function territoryBounds(territory: Territory): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of territory) {
    for (const [x, y] of poly[0] ?? []) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * True when the two boxes share no point at all — so the shapes inside them
 * cannot overlap either, and a boolean op between them is decided in advance.
 *
 * Deliberately conservative at the boundary: boxes that merely TOUCH are not
 * separated. They enclose no common area, but nothing downstream may depend
 * on that subtlety — the cheap test only ever earns the right to skip work,
 * never to guess at a result.
 */
export function boundsSeparated(a: Bounds, b: Bounds): boolean {
  return a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
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
