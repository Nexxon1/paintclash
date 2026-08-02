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
 * robustly — and subnormal doubles (a corruption trigger verified against the
 * engine of the day: `difference` emitted a hole outside its outer ring)
 * cannot occur at all. 200 WU × 1e7 < 2^53, so the lattice is exact in
 * doubles. Why this width survived the ticket-23 engine swap unchanged, when
 * ADR-0007 says widths do not transfer between engines: see `clipper.ts`.
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

/**
 * Sub-loops below this magnitude are float debris, not land — the same floor
 * `fill.ts` reads its clipper output with, applied to the bays cut out below
 * so that noise in a boundary never counts as an enclosure.
 */
const BAY_AREA_FLOOR_WU2 = 1e-9;

/** What `sealEnclosedBays` found in one ring. */
export interface SealedBays {
  /** The ring with every bay cut out — the enclosures, filled. */
  ring: Ring;
  /** The cut-out bays as CCW rings, in the order they were found. */
  bays: Ring[];
}

/**
 * Fill the enclosures a ring wraps around through a neck no wider than
 * `tolWU`, and hand them back.
 *
 * A boolean union answers "is this land a hole?" topologically, and that
 * answer disagrees with the eye exactly once: when the boundary leaves the
 * enclosure open through a channel far too narrow to see or to drive through.
 * The clipper then reports one outer ring that walks out around the pocket
 * the wrong way and back — no hole ring, nothing for a hole-fill to find, and
 * a permanently unpainted island inside a player's own land (ticket 30).
 * Measured over ten minutes of a saturated arena: necks of **4e-7 to 8e-7 WU**
 * — four to eight lattice cells, a ten-millionth of the arena's width —
 * around pockets of up to **3,6 WU²**.
 *
 * So the question this asks is not the topological one but the one the player
 * is actually asking: *is this land walled in?* A neck below `tolWU` is not a
 * way out, so the sub-loop behind it is an enclosure and the fill owns it.
 *
 * Only sub-loops wound AGAINST the ring are cut: the ring is an outer
 * boundary (CCW), so a clockwise excursion is land the boundary excludes,
 * while a counter-clockwise one is two lobes of owned land touching — real
 * geometry, left alone. Cutting is iterated, so a bay inside a bay is found
 * on the next pass, and each cut shortens the ring, so it terminates.
 *
 * The bays are returned because the fill has a second use for them: enclosed
 * FOREIGN land is stolen (spec §2.2), and the steal carves with the region a
 * fill gained. A bay the winner keeps but never carves would be owned twice.
 */
export function sealEnclosedBays(ring: Ring, tolWU: number): SealedBays {
  const bays: Ring[] = [];
  let current = ring;
  // "Against the ring" is only meaningful once the ring itself has a
  // direction. Outer rings come out of the clipper CCW, so anything else is
  // corrupt output — and on that the reading would invert: the land lobes
  // would look like the bays. Hand it back untouched instead.
  if (ringArea(ring) <= 0) return { ring, bays };
  for (;;) {
    const cut = firstBay(current, tolWU);
    if (cut === null) return { ring: current, bays };
    const [from, to] = cut;
    bays.push([...current.slice(from, to)].reverse());
    current = [...current.slice(0, from), ...current.slice(to)];
  }
}

/**
 * The first bay in a ring as the half-open index range `[from, to)` that spans
 * it, or `null` when there is none.
 *
 * Necks are pairs of near-coincident vertices, and finding them is the part
 * that has to be cheap: this runs inside the fill, which is what the tick
 * budget is spent on (tickets 22/23), it runs on every capture, and rings in a
 * saturated arena carry hundreds of vertices. So the pairs come out of a hash
 * grid of `tolWU`-wide cells — linear in the vertex count, against the
 * quadratic sweep the obvious version would do — and the ring is walked to
 * measure a sub-loop only for a pair that already passed the distance test,
 * which in a run without bays never happens at all.
 *
 * Grid cells are keyed by a HASH of their coordinates rather than by a packed
 * index, so no assumption about the arena's extent is baked in here. A
 * collision only ever adds a candidate, and every candidate is verified by its
 * real distance — it can cost a few comparisons, never a wrong answer.
 */
function firstBay(ring: Ring, tolWU: number): [number, number] | null {
  const n = ring.length;
  // Both sides must come out as rings of their own: three vertices each.
  if (n < 6) return null;
  const tolSqWU2 = tolWU * tolWU;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (p === undefined) continue;
    const key = cellHash(Math.floor(p[0] / tolWU), Math.floor(p[1] / tolWU));
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [i]);
    else bucket.push(i);
  }
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    if (a === undefined) continue;
    const cx = Math.floor(a[0] / tolWU);
    const cy = Math.floor(a[1] / tolWU);
    // Smallest partner wins, so the cut is the ring's own order rather than
    // the order nine interleaved buckets happen to hand back.
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(cellHash(cx + dx, cy + dy)) ?? []) {
          // Neighbours along the ring share an edge, not a neck — and the
          // first and last vertex are neighbours too, around the wrap.
          if (j - i < 3 || n - (j - i) < 3) continue;
          if (best !== -1 && j >= best) continue;
          const b = ring[j];
          if (b === undefined) continue;
          const ddx = a[0] - b[0];
          const ddy = a[1] - b[1];
          if (ddx * ddx + ddy * ddy <= tolSqWU2) best = j;
        }
      }
    }
    if (best !== -1 && ringArea(ring.slice(i, best)) < -BAY_AREA_FLOOR_WU2) return [i, best];
  }
  return null;
}

/**
 * Spread two cell indices over one integer. Only ever used to look a bucket
 * up, never to reconstruct a cell, so the constants just need to mix.
 */
function cellHash(cx: number, cy: number): number {
  return Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663);
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
