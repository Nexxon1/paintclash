/**
 * The autopilot the load probe flies (ticket 16). Its whole job is to make a
 * headless client produce the ONE thing the tick budget is about: closed loops
 * that fill, over and over, so territories grow vertices and the fill cost
 * climbs the curve tickets 22/23 measured.
 *
 * It is deliberately not `BotPilot`. The server's bots decide from a `Sight`
 * built out of the full `SimState`, which a client does not have and must not
 * need — a client sees snapshots and territory syncs. So this is a waypoint
 * autopilot over exactly what a client knows, and the lobe it flies is the same
 * shape the scenario suite grows land with (`tests/scenario/leaderboard.test.ts`):
 * a dogleg to align, out to the tip, a side gate that forces the U-turn
 * direction, a return corridor beside the out leg, then home from the side.
 *
 * Pure and synchronous, which is what lets `pilot.test.ts` prove the premise
 * — "these clients actually paint" — against a local sim, with no network at
 * all. Without that guard a broken pilot would make the load run measure an
 * arena of heads driving in circles and report a comfortable tick budget for
 * the wrong reason.
 */

import type { Point, Territory, TurnSignal } from '@paintclash/shared';

/** Everything the autopilot needs about its own head. */
export interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** Shortest arc from `from` to `to` in radians. */
export function shortestArc(from: number, to: number): number {
  const TWO_PI = 2 * Math.PI;
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Bang-bang steering toward a target point, with a small deadband. */
export function steerToward(self: Pose, target: Point): TurnSignal {
  const bearing = Math.atan2(target[1] - self.y, target[0] - self.x);
  const diff = shortestArc(self.heading, bearing);
  if (Math.abs(diff) < 0.06) return 0;
  return diff > 0 ? 1 : -1;
}

/** Centroid of a territory's first outer ring, or `null` if it owns nothing. */
export function ringCenter(territory: Territory): Point | null {
  const ring = territory[0]?.[0];
  if (!ring || ring.length === 0) return null;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x / ring.length;
    cy += y / ring.length;
  }
  return [cx, cy];
}

const AXES: readonly Point[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Axis with the most room, starting the search at `from` so two pilots on
 * neighbouring blocks do not fly the identical lobe. The tip needs U-turn
 * space; a lobe aimed at a wall gets its head pinned by the soft barrier and
 * never closes.
 */
export function roomiestDirection(center: Point, arenaSizeWU: number, from = 0): Point {
  const room = (d: Point): number => {
    const tx = center[0] + d[0] * LOBE_REACH_WU;
    const ty = center[1] + d[1] * LOBE_REACH_WU;
    return Math.min(tx, ty, arenaSizeWU - tx, arenaSizeWU - ty);
  };
  const ordered = AXES.map((_, i) => AXES[(i + from) % AXES.length]!);
  return ordered.reduce((best, d) => (room(d) > room(best) ? d : best));
}

/** How far out the lobe reaches, plus the room its U-turn needs. */
const LOBE_REACH_WU = 22;

/**
 * The lobe: five waypoints that leave the block, turn around and come back in
 * beside the outbound leg, enclosing a strip of ground on the way.
 */
export function lobeWaypoints(center: Point, dir: Point): Point[] {
  const perpendicular: Point = [-dir[1], dir[0]];
  const tip: Point = [center[0] + dir[0] * 18, center[1] + dir[1] * 18];
  return [
    [center[0] - dir[0] * 3.5, center[1] - dir[1] * 3.5],
    tip,
    [tip[0] + perpendicular[0] * 4, tip[1] + perpendicular[1] * 4],
    [center[0] + perpendicular[0] * 4, center[1] + perpendicular[1] * 4],
    center,
  ];
}

/** Ticks a single leg may take before the pilot gives up on it — see `steer`. */
const LEG_PATIENCE_TICKS = 200;

/** Distance at which a waypoint counts as reached, in WU. */
const REACH_WU = 2;

export class LoopPilot {
  private waypoints: Point[] = [];
  private index = 0;
  private legTicks = 0;
  private lobes = 0;

  constructor(private readonly arenaSizeWU: number) {}

  /** Completed lobes — the premise `pilot.test.ts` checks. */
  get lobesFlown(): number {
    return this.lobes;
  }

  /**
   * One tick of steering. `territory` is the pilot's OWN land as the client
   * last saw it; an empty one (dead, or the first snapshot before the sync
   * arrives) simply means "fly straight and wait" rather than an error.
   */
  steer(self: Pose, territory: Territory): TurnSignal {
    const home = ringCenter(territory);
    if (!home) {
      // Died, or not synced yet. Drop the plan: it was drawn around a block
      // that is no longer ours, and flying it now would aim the head at a
      // stranger's land with no way home.
      this.waypoints = [];
      return 0;
    }
    if (this.waypoints.length === 0) this.plan(home);
    this.legTicks += 1;
    // A leg the head cannot finish — pinned on the barrier, or shoved off
    // course by a collision — must not park the pilot forever. Skipping to the
    // next waypoint is what keeps a five-minute run producing fills instead of
    // one client quietly idling against a wall.
    const target = this.waypoints[this.index];
    if (!target || this.reached(self, target) || this.legTicks > LEG_PATIENCE_TICKS) {
      this.index += 1;
      this.legTicks = 0;
      if (this.index >= this.waypoints.length) {
        this.lobes += 1;
        this.plan(home);
      }
    }
    const next = this.waypoints[this.index];
    return next ? steerToward(self, next) : 0;
  }

  /** Draw a fresh lobe around the block we currently own. */
  private plan(home: Point): void {
    this.waypoints = lobeWaypoints(home, roomiestDirection(home, this.arenaSizeWU, this.lobes));
    this.index = 0;
    this.legTicks = 0;
  }

  /** Reach-check against the waypoint clamped into the arena (wall-pinned). */
  private reached(self: Pose, target: Point): boolean {
    const cx = Math.min(this.arenaSizeWU, Math.max(0, target[0]));
    const cy = Math.min(this.arenaSizeWU, Math.max(0, target[1]));
    return Math.hypot(cx - self.x, cy - self.y) < REACH_WU;
  }
}
