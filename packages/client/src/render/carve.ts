/**
 * Trail carve-through (spec §4.1/4.2, ticket 06): where a trail crosses a
 * raised foreign plateau, the crossed strip sinks to ground level — the
 * ground ribbon then runs in a real trench. Implemented as actual geometry
 * (the trail's band subtracted from the plateau polygon) so trench walls
 * shade correctly. Pure polygon math, no three.js — render-only, never part
 * of the simulation truth.
 *
 * Cost model (all numbers measured): the sim's clipper USED to be polyclip-ts,
 * which runs on arbitrary-precision arithmetic — a one-shot band difference
 * costs ~1 s at 500 trail points and froze the frame while crossing enemy
 * land. Here cosmetics beat exactness, so this module took `polygon-clipping`
 * instead (same Martinez sweep, float + robust predicates, ~10× faster), and
 * `PlateauCarver` keeps the per-update work small on top: grooves are monotone
 * while a trail lives, so each update clips ONLY the segments added since the
 * last one, against ONLY the carved pieces they touch — a decimated full
 * recarve runs just when the base plateau or a crossing trail is replaced.
 *
 * Ticket 23 moved the SIM onto the same engine for the same factor
 * (`sim-core/clipper.ts`), so the two are no longer split by precision — only
 * by lattice width, which stays a per-caller decision: 1e-4 here, 1e-7 there
 * (see below, and `clipper.ts` for why the sim cannot follow).
 *
 * Float speed is bought with float robustness, and that bill came due in
 * ticket 25: unsnapped inputs made the sweep grind for SECONDS on geometry
 * of a handful of vertices. Everything entering the clipper is therefore on
 * a snap lattice now — see `CARVE_LATTICE_INV_WU`. Budget under a saturating
 * arena: [`bench/carve-budget`](../../../../bench/carve-budget/).
 */

import { BALANCE, type Point, type Ring, type Territory } from '@paintclash/shared';
import * as polygonClipping from 'polygon-clipping';

/**
 * polygon-clipping ships mismatched builds: the ESM bundle (what Vite
 * browser builds resolve) only has a DEFAULT export, while the type
 * declarations and the CJS build (what Vitest resolves) expose named
 * exports. Unwrap whichever shape the active bundler produced.
 */
interface Clipper {
  difference: typeof polygonClipping.difference;
}
const clipperInterop = polygonClipping as unknown as Clipper & { default?: Clipper };
const { difference } = clipperInterop.default ?? clipperInterop;

/**
 * Snap lattice for everything entering the clipper, in inverse WU — the same
 * medicine ADR-0007 prescribes for the sim's clipper, for the same reason:
 * near-coincident vertices collapse to EXACTLY coincident ones, which a
 * Martinez sweep handles robustly, while a hair's-width miss sends it hunting
 * for intersections that float arithmetic then refuses to confirm.
 *
 * Without it, `polygon-clipping` does not merely lose precision here — it
 * grinds. Measured against the deployed build (ticket 25): a ~500-vertex
 * plateau minus two groove quads spent **0,7–2,6 s** in the sweep and then
 * threw `unable to complete output ring`; six such carves in five minutes of
 * a saturating arena, the worst 4,4 s. Every one of them completes in **~1 ms**
 * on the lattice. The failures were never about size — the inputs are tiny —
 * they were about vertices that miss each other by 1e-12 WU.
 *
 * 1e-4 WU (a ten-thousandth of a trail's width) rather than the sim's 1e-7:
 * this is cosmetics, so a coarser lattice is strictly better — it collapses
 * MORE near-coincidences, and the movement it costs is four orders of
 * magnitude below one screen pixel at any playable zoom.
 */
const CARVE_LATTICE_INV_WU = 1e4;

/** Put one clipper operand on the carve lattice (see `CARVE_LATTICE_INV_WU`). */
function snapOperand(operand: Territory): Territory {
  return operand.map((poly) =>
    poly.map((ring) =>
      ring.map(([x, y]): Point => [
        Math.round(x * CARVE_LATTICE_INV_WU) / CARVE_LATTICE_INV_WU,
        Math.round(y * CARVE_LATTICE_INV_WU) / CARVE_LATTICE_INV_WU,
      ]),
    ),
  );
}

/**
 * `difference`, with every operand on the carve lattice — the ONE place this
 * module talks to the clipper, so no path can skip the snap.
 *
 * Inputs only, unlike the sim (ADR-0007 snaps its OUTPUT back too). The sim
 * has to: it stores the result, and every later op builds on it. Nothing
 * here is stored as truth — a carve result only ever re-enters the clipper
 * through this very function, which snaps it then.
 */
function snappedDifference(subject: Territory, clips: readonly Territory[]): Territory {
  return difference(snapOperand(subject), ...clips.map(snapOperand));
}

/**
 * Groove width: a shade wider than the ribbon, so the ribbon's edges never
 * touch (and z-fight) the trench walls.
 */
export const CARVE_WIDTH_WU = BALANCE.trail.widthWU + 0.2;

/**
 * Minimum time between carve updates of one plateau (§4.1 carve-through:
 * crossing trails cut a ground-level groove into the plateau geometry).
 * Each update clips only the trail growth since the last one (PlateauCarver)
 * plus a mesh rebuild — tick cadence is plenty; between updates the groove
 * front trails the head by < 0.5 WU, visually hidden under the head cone.
 *
 * Lives here rather than in the scene that applies it because it is half of
 * what the carve costs per second, and `bench/carve-budget` has to pace
 * itself by the same number to measure the frame the client actually draws.
 */
export const CARVE_THROTTLE_MS = 50;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Axis-aligned bounds of a polyline; null when empty. */
export function pointsBounds(points: readonly Point[]): Bounds | null {
  const first = points[0];
  if (first === undefined) return null;
  const bounds: Bounds = { minX: first[0], minY: first[1], maxX: first[0], maxY: first[1] };
  for (const [x, y] of points) {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
  }
  return bounds;
}

/** Axis-aligned bounds of a territory (all rings); null when empty. */
export function territoryBounds(territory: Territory): Bounds | null {
  let bounds: Bounds | null = null;
  for (const poly of territory) {
    for (const ring of poly) {
      const ringBounds = pointsBounds(ring);
      if (!ringBounds) continue;
      if (!bounds) {
        bounds = ringBounds;
      } else {
        bounds.minX = Math.min(bounds.minX, ringBounds.minX);
        bounds.minY = Math.min(bounds.minY, ringBounds.minY);
        bounds.maxX = Math.max(bounds.maxX, ringBounds.maxX);
        bounds.maxY = Math.max(bounds.maxY, ringBounds.maxY);
      }
    }
  }
  return bounds;
}

/** Do two bounds come within `margin` of each other? */
export function boundsOverlap(a: Bounds, b: Bounds, margin: number): boolean {
  return (
    a.minX - margin <= b.maxX &&
    b.minX - margin <= a.maxX &&
    a.minY - margin <= b.maxY &&
    b.minY - margin <= a.maxY
  );
}

/**
 * The carve quad of one trail segment: its rectangle widened to the groove
 * width AND extended by half of it beyond both endpoints — consecutive
 * extended quads overlap at the joint, covering every direction change the
 * gentle sim turn rate can produce without any joint discs.
 */
function segmentQuad(a: Point, b: Point, half: number): Ring | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = (dx / len) * half;
  const uy = (dy / len) * half;
  const ax = a[0] - ux;
  const ay = a[1] - uy;
  const bx = b[0] + ux;
  const by = b[1] + uy;
  return [
    [ax - uy, ay + ux],
    [bx - uy, by + ux],
    [bx + uy, by - ux],
    [ax + uy, ay - ux],
  ];
}

/** Groove quads of one polyline, limited to segments near `within`. */
function bandQuads(trail: readonly Point[], within: Bounds): Territory[] {
  const half = CARVE_WIDTH_WU / 2;
  const quads: Territory[] = [];
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    if (!a || !b) continue;
    const segBounds = pointsBounds([a, b]);
    if (!segBounds || !boundsOverlap(segBounds, within, half)) continue;
    const quad = segmentQuad(a, b, half);
    if (quad) quads.push([[quad]]);
  }
  return quads;
}

/**
 * Ramer–Douglas–Peucker polyline simplification: drop every vertex within
 * `epsilonWU` of the chord between its kept neighbors. Trail polylines are
 * sampled every 0.1 WU; for a 1.2-WU-wide groove a 0.1 WU deviation is
 * invisible, and the clipper's cost scales with segment count.
 */
export function simplifyPolyline(points: readonly Point[], epsilonWU: number): Point[] {
  if (points.length <= 2) return points.map((p): Point => [p[0], p[1]]);
  const epsSq = epsilonWU * epsilonWU;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const spans: [number, number][] = [[0, points.length - 1]];
  for (let span = spans.pop(); span !== undefined; span = spans.pop()) {
    const [lo, hi] = span;
    const a = points[lo];
    const b = points[hi];
    if (a === undefined || b === undefined || hi - lo < 2) continue;
    let worst = epsSq;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      if (p === undefined) continue;
      const d = segmentDistanceSq(p, a, b);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worstAt !== -1) {
      keep[worstAt] = true;
      spans.push([lo, worstAt], [worstAt, hi]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p): Point => [p[0], p[1]]);
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
 * Subtract the groove bands of the given trail polylines from a territory,
 * in one shot. Only segments near the territory participate; when nothing
 * is close — or the clipper fails on degenerate input — the input reference
 * comes back unchanged: an uncarved plateau always beats a crash, this is
 * cosmetics, not truth. For per-frame use prefer `PlateauCarver`.
 */
export function carveTerritory(territory: Territory, trails: readonly Point[][]): Territory {
  const bounds = territoryBounds(territory);
  if (!bounds) return territory;
  const quads: Territory[] = [];
  for (const trail of trails) {
    quads.push(...bandQuads(trail, bounds));
  }
  if (quads.length === 0) return territory;
  try {
    return snappedDifference(territory, quads);
  } catch {
    return territory;
  }
}

/** One crossing trail, identified by its owner. */
export interface CarveInput {
  playerId: number;
  points: readonly Point[];
}

/** The groove front must advance this far before another clip is worth it. */
const TIP_ADVANCE_WU = 0.3;
/** Decimation tolerance for full recarves (see simplifyPolyline). */
const SIMPLIFY_EPS_WU = 0.1;

/** Per-trail carve bookkeeping: what part of it is already groove. */
interface TrailProgress {
  /** Trail points frozen into the groove so far (excludes the live tip). */
  carvedCount: number;
  /** Where the groove front last reached (the tip at the last clip). */
  tip: Point;
}

/**
 * Incremental carve state of ONE plateau. Grooves only ever grow while a
 * trail lives, so each update clips just the segments added since the last
 * one — the expensive whole-band difference runs only when the base plateau
 * is replaced (fill/sync) or a crossing trail ends/restarts. `update`
 * returns the SAME reference while nothing changed; callers rebuild their
 * mesh exactly when the reference moves.
 */
export class PlateauCarver {
  private base: Territory = [];
  private baseBounds: Bounds | null = null;
  private carved: Territory = [];
  private readonly progress = new Map<number, TrailProgress>();

  /** Adopt a new base plateau (territory sync/fill) — grooves recut fresh. */
  reset(base: Territory): void {
    this.base = base;
    this.baseBounds = territoryBounds(base);
    this.carved = base;
    this.progress.clear();
  }

  /**
   * Bring the grooves up to date with the crossing trails and return the
   * carved plateau. Pass only trails that actually come near this plateau —
   * a trail vanishing from the list reads as "ended" and heals its groove.
   */
  update(trails: readonly CarveInput[]): Territory {
    const bounds = this.baseBounds;
    if (bounds === null) return this.carved;
    // A vanished trail (fill/death) or a restarted one (fewer points than
    // already carved) invalidates its groove — heal by recutting everything
    // still crossing from the pristine base.
    let heal = trails.some((t) => {
      const prev = this.progress.get(t.playerId);
      return prev !== undefined && prev.carvedCount > t.points.length - 1;
    });
    if (!heal && this.progress.size > 0) {
      const present = new Set(trails.map((t) => t.playerId));
      for (const id of this.progress.keys()) {
        if (!present.has(id)) {
          heal = true;
          break;
        }
      }
    }
    if (heal) {
      this.carved = this.base;
      this.progress.clear();
    }
    const quads: Territory[] = [];
    for (const t of trails) {
      const tipAt = t.points.length - 1;
      const tip = t.points[tipAt];
      if (tip === undefined) continue;
      const prev = this.progress.get(t.playerId);
      if (
        prev?.carvedCount === tipAt &&
        Math.hypot(tip[0] - prev.tip[0], tip[1] - prev.tip[1]) < TIP_ADVANCE_WU
      ) {
        continue; // groove front already at the head
      }
      // New trail (or post-heal): the whole band, decimated. Known trail:
      // just the piece since the last clip — one overlap segment covers the
      // collinear-merged last point having stretched in place.
      const from = prev ? Math.max(0, prev.carvedCount - 1) : 0;
      const piece = prev ? t.points.slice(from) : simplifyPolyline(t.points, SIMPLIFY_EPS_WU);
      quads.push(...bandQuads(piece, bounds));
      this.progress.set(t.playerId, { carvedCount: tipAt, tip: [tip[0], tip[1]] });
    }
    if (quads.length > 0) this.clip(quads);
    return this.carved;
  }

  /**
   * Subtract the quads from the carved shape — but only from the pieces
   * they actually touch. Once a groove severs the plateau, the far pieces
   * never see the sweep again, keeping the per-update clip small however
   * long the crossing gets.
   */
  private clip(quads: readonly Territory[]): void {
    let clipBounds: Bounds | null = null;
    for (const quad of quads) {
      const ring = quad[0]?.[0];
      const quadBounds = ring ? pointsBounds(ring) : null;
      if (!quadBounds) continue;
      if (!clipBounds) {
        clipBounds = quadBounds;
      } else {
        clipBounds.minX = Math.min(clipBounds.minX, quadBounds.minX);
        clipBounds.minY = Math.min(clipBounds.minY, quadBounds.minY);
        clipBounds.maxX = Math.max(clipBounds.maxX, quadBounds.maxX);
        clipBounds.maxY = Math.max(clipBounds.maxY, quadBounds.maxY);
      }
    }
    if (!clipBounds) return;
    const touched: Territory = [];
    const untouched: Territory = [];
    for (const poly of this.carved) {
      const outer = poly[0];
      const polyBounds = outer ? pointsBounds(outer) : null;
      if (polyBounds && boundsOverlap(polyBounds, clipBounds, 0)) {
        touched.push(poly);
      } else {
        untouched.push(poly);
      }
    }
    if (touched.length === 0) return;
    try {
      this.carved = [...snappedDifference(touched, quads), ...untouched];
    } catch {
      // Clipper failure on degenerate input: keep the last good shape —
      // cosmetics must never take the frame down.
    }
  }
}
