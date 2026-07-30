/**
 * Bot pilots (ADR-0005, ticket 12) — server-internal entities that feed the
 * SAME input seam as network players: a pilot's whole output is one
 * `TurnSignal` per tick, handed to `step`'s `turns` exactly like a decoded
 * client intent. It cannot express a position, a speed or another player's id,
 * so a bot is not merely trusted not to cheat — it has no vocabulary for it.
 *
 * Everything a pilot may know arrives as a `BotSight`, built by `senseFor` from
 * the authoritative state and deliberately narrower than that state: heads
 * farther than `BALANCE.bots.sightRadiusWU` away do not exist for a bot
 * (ADR-0005: "only what a human could see"). That is half of what makes them
 * beatable; the other half is `reactionTicks` — between two decisions a pilot
 * flies on, blind to anything that changed.
 *
 * Kept free of any Durable Object API and of the wire format, so every decision
 * is unit-testable in plain node (spec §9.1).
 */

import {
  BALANCE,
  type Point,
  type Ring,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import { pointInTerritory, type SimState } from '@paintclash/sim-core';

/**
 * The bot's own state — it knows itself in full. The fields are readonly because
 * the sight carries LIVE references into the authoritative state: a pilot writing
 * to them would be the special path ADR-0005 rules out. Note what that does and
 * does not buy — the pose is sealed, while `territory` and `trail` are the sim's
 * own mutable arrays (deep-readonly geometry would not fit `sim-core`'s
 * signatures). The guarantee that actually binds is the return type: a pilot's
 * only output is one `TurnSignal`.
 */
export interface BotSelf {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly territory: Territory;
  readonly trail: readonly Point[];
}

/** Everything one pilot may read this tick — never the whole world. */
export interface BotSight {
  /** Arena tick, so a pilot can pace its own decisions (`reactionTicks`). */
  readonly tick: number;
  readonly arenaSizeWU: number;
  readonly self: BotSelf;
  /** Foreign heads within the sight radius — positions only. */
  readonly threats: readonly Point[];
}

/**
 * The limited view of `botId`'s surroundings, or null when that bot has no body
 * in the sim — a join spawns on the NEXT tick, so the caller must cope with a
 * pilot that cannot steer yet.
 */
export function senseFor(state: SimState, botId: number): BotSight | null {
  const self = state.players.find((p) => p.id === botId);
  if (!self) return null;
  const sightSq = BALANCE.bots.sightRadiusWU ** 2;
  const threats: Point[] = [];
  for (const other of state.players) {
    if (other.id === botId) continue;
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    if (dx * dx + dy * dy <= sightSq) threats.push([other.x, other.y]);
  }
  return { tick: state.tick, arenaSizeWU: state.arenaSizeWU, self, threats };
}

const TWO_PI = 2 * Math.PI;
/** Turn radius at the balanced speed/turn rate ≈ 1.61 WU. */
const TURN_RADIUS_WU =
  BALANCE.movement.speedWuPerSec / ((BALANCE.movement.turnRateDegPerSec * Math.PI) / 180);
/**
 * How close counts as "waypoint reached". Must exceed the turn radius: a head
 * that misses a tighter target can only orbit it, never touch it.
 */
const WAYPOINT_REACH_WU = TURN_RADIUS_WU + 0.5;
/**
 * Steering deadband in radians — below half a tick's turn authority (16°/tick)
 * a correction would overshoot, so the pilot holds course instead of chattering
 * ±1 around its bearing.
 */
const STEER_DEADBAND_RAD = ((BALANCE.movement.turnRateDegPerSec * Math.PI) / 180) * 0.025;
/**
 * Trail length that turns an excursion into a committed one. Below it the head
 * has merely grazed its own border (the sub-radius wobble of ticket 20) — the
 * run must not count as done and send the pilot straight back to planning.
 */
const COMMIT_TRAIL_WU = BALANCE.spawn.startBlockWU;
/** How far past the own border a returning bot aims, so it truly re-enters. */
const REENTRY_OVERSHOOT_WU = 2;
/**
 * Below this distance the head counts as standing ON its own border, where
 * "aim at the nearest border point" degenerates into "aim at yourself" — no
 * steer intent at all. Harmless in open field, fatal against the arena edge:
 * the barrier then holds the bot there forever, and a pinned head lays no new
 * trail, so the exposure cap never fires either.
 */
const ON_BORDER_EPS_WU = 1e-6;

/** The four axis directions an excursion can take. */
const DIRECTIONS: readonly Point[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** Shortest signed arc from `from` to `to`, in radians. */
function shortestArc(from: number, to: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Bang-bang steer intent toward a point — the only thing a pilot may emit. */
function steerToward(self: BotSelf, target: Point): TurnSignal {
  const bearing = Math.atan2(target[1] - self.y, target[0] - self.x);
  const diff = shortestArc(self.heading, bearing);
  if (Math.abs(diff) < STEER_DEADBAND_RAD) return 0;
  return diff > 0 ? 1 : -1;
}

/** Path length of a trail polyline, in WU — indexed, so it allocates nothing. */
function trailLengthWU(trail: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1];
    const point = trail[i];
    if (prev === undefined || point === undefined) continue;
    total += Math.hypot(point[0] - prev[0], point[1] - prev[1]);
  }
  return total;
}

/**
 * Closest point on one ring's edges. Steering geometry, not sim truth — the
 * authoritative distances live in `sim-core/geometry.ts`; a pilot only needs
 * somewhere to aim.
 */
function closestOnRing(x: number, y: number, ring: Ring): { point: Point; distSq: number } | null {
  let best: { point: Point; distSq: number } | null = null;
  let prev = ring[ring.length - 1];
  if (prev === undefined) return null;
  for (const curr of ring) {
    const abx = curr[0] - prev[0];
    const aby = curr[1] - prev[1];
    const lengthSq = abx * abx + aby * aby;
    let t = 0;
    if (lengthSq > 0) {
      t = Math.min(1, Math.max(0, ((x - prev[0]) * abx + (y - prev[1]) * aby) / lengthSq));
    }
    const point: Point = [prev[0] + t * abx, prev[1] + t * aby];
    const distSq = (x - point[0]) ** 2 + (y - point[1]) ** 2;
    if (!best || distSq < best.distSq) best = { point, distSq };
    prev = curr;
  }
  return best;
}

/** Closest point on a territory's border, or null when it owns nothing. */
function closestOnTerritory(x: number, y: number, territory: Territory): Point | null {
  let best: { point: Point; distSq: number } | null = null;
  for (const poly of territory) {
    for (const ring of poly) {
      const candidate = closestOnRing(x, y, ring);
      if (candidate && (!best || candidate.distSq < best.distSq)) best = candidate;
    }
  }
  return best?.point ?? null;
}

/** Average of a territory's outer-ring vertices — "roughly where my land is". */
function territoryCenter(territory: Territory): Point | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const poly of territory) {
    for (const [x, y] of poly[0] ?? []) {
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  return count === 0 ? null : [sumX / count, sumY / count];
}

/** Keep a point inside the arena (optionally clear of the edge by `marginWU`). */
function clampToArena(point: Point, arenaSizeWU: number, marginWU = 0): Point {
  // A margin can never eat more than the middle half of a tiny arena.
  const margin = Math.min(marginWU, arenaSizeWU / 4);
  const clamp = (v: number): number => Math.min(arenaSizeWU - margin, Math.max(margin, v));
  return [clamp(point[0]), clamp(point[1])];
}

/**
 * Where a bot outside its land aims to close the loop: the nearest own border
 * point, overshot by a couple of WU along the approach so the head ends up
 * genuinely INSIDE instead of grazing the edge and riding along it.
 *
 * Standing exactly on that border (`ON_BORDER_EPS_WU`) the approach direction
 * vanishes, so the aim falls back to the territory's own mass — which points
 * away from the arena edge and un-pins a bot the barrier is holding.
 */
function reentryTarget(self: BotSelf, arenaSizeWU: number): Point | null {
  const border = closestOnTerritory(self.x, self.y, self.territory);
  if (!border) return null;
  let dx = border[0] - self.x;
  let dy = border[1] - self.y;
  if (Math.hypot(dx, dy) < ON_BORDER_EPS_WU) {
    const inward = territoryCenter(self.territory);
    if (!inward) return null;
    dx = inward[0] - self.x;
    dy = inward[1] - self.y;
  }
  const dist = Math.hypot(dx, dy);
  // Head, border and land centre all in one spot: nothing sane to aim at.
  if (dist < ON_BORDER_EPS_WU) return null;
  const scale = (dist + REENTRY_OVERSHOOT_WU) / dist;
  return clampToArena([self.x + dx * scale, self.y + dy * scale], arenaSizeWU);
}

/**
 * The excursion: out to a tip, one U-turn, back along a lane offset by
 * `laneOffsetWU` — the loop whose enclosed strip becomes the fill. Coming home
 * is deliberately NOT a waypoint: the last leg is re-derived live
 * (`reentryTarget`), so a bot whose home was stolen mid-run still aims at land
 * it actually owns.
 */
function excursion(origin: Point, dir: Point, side: number): Point[] {
  const { excursionWU, laneOffsetWU } = BALANCE.bots;
  const perpX = -dir[1] * side * laneOffsetWU;
  const perpY = dir[0] * side * laneOffsetWU;
  const tip: Point = [origin[0] + dir[0] * excursionWU, origin[1] + dir[1] * excursionWU];
  return [tip, [tip[0] + perpX, tip[1] + perpY], [origin[0] + perpX, origin[1] + perpY]];
}

/**
 * How much room a plan has, in WU: the tightest clearance any of its waypoints
 * keeps from the arena edge and from every head the bot can see. Walls and
 * rivals are scored in the same currency on purpose — a lobe that would pin
 * the head against the barrier is exactly as bad as one flown into a rival.
 */
function planClearance(plan: readonly Point[], sight: BotSight): number {
  let worst = Infinity;
  for (const [x, y] of plan) {
    worst = Math.min(worst, x, y, sight.arenaSizeWU - x, sight.arenaSizeWU - y);
    for (const [tx, ty] of sight.threats) {
      worst = Math.min(worst, Math.hypot(x - tx, y - ty));
    }
  }
  return worst;
}

/**
 * One bot's pilot: a heuristic that plays the core loop (leave, close the loop,
 * fill, evade) and nothing else. Holds the current excursion as its only
 * memory; every fact about the world it re-reads from the sight it is handed.
 */
export class BotPilot {
  private plan: Point[] = [];
  private index = 0;
  /** Head position the current plan was drawn around — a respawn invalidates it. */
  private planOrigin: Point | null = null;
  /** Has this run left the own land for real (see COMMIT_TRAIL_WU)? */
  private committed = false;
  private nextDecisionTick = 0;

  constructor(private readonly id: number) {}

  /** The steer intent for this tick — the pilot's entire output. */
  steer(sight: BotSight): TurnSignal {
    if (sight.tick >= this.nextDecisionTick) {
      this.nextDecisionTick = sight.tick + BALANCE.bots.reactionTicks;
      this.decide(sight);
    }
    const target = this.currentTarget(sight.self, sight.arenaSizeWU);
    return target ? steerToward(sight.self, target) : 0;
  }

  /**
   * The rare, deliberate part (`reactionTicks`): plan a fresh excursion, or
   * abandon the running one. Path FOLLOWING happens every tick — a human
   * commits to a maneuver too, they just cannot re-decide 20 times a second.
   */
  private decide(sight: BotSight): void {
    const self = sight.self;
    const outside = self.trail.length > 0;
    const trailWU = outside ? trailLengthWU(self.trail) : 0;
    if (trailWU > COMMIT_TRAIL_WU) this.committed = true;
    const respawned =
      this.planOrigin !== null &&
      !pointInTerritory(this.planOrigin[0], this.planOrigin[1], self.territory);
    // A closed loop (or a death) ends the run: the trail is gone and the head
    // is home again. Anything before COMMIT_TRAIL_WU was border wobble, not a
    // run — replanning on that would keep the bot circling its own block.
    if (respawned || this.plan.length === 0 || (!outside && this.committed)) {
      this.planExcursion(sight);
      return;
    }
    if (!outside) return; // still on the way out
    // Evade (spec §2.7 "ausweichen") and the exposure cap share one answer:
    // abandon the excursion and take the shortest way back onto own land —
    // which also closes the loop, so fleeing still paints.
    const threatened = sight.threats.some(
      ([tx, ty]) => Math.hypot(tx - self.x, ty - self.y) <= BALANCE.bots.evadeRadiusWU,
    );
    if (threatened || trailWU > BALANCE.bots.maxTrailWU) this.index = this.plan.length;
  }

  /**
   * Draw the next excursion around the head's current position — which is by
   * construction inside the own land, so the loop has something to close on.
   * The best-scoring of the eight candidate lobes wins; the candidate ORDER
   * starts at the direction the head already flies (no needless U-turn) and is
   * offset per bot id, so equally-good options don't make every bot in the
   * arena fly the same shape.
   */
  private planExcursion(sight: BotSight): void {
    const self = sight.self;
    const origin: Point = [self.x, self.y];
    const aligned = [...DIRECTIONS].sort(
      (a, b) =>
        Math.abs(shortestArc(self.heading, Math.atan2(a[1], a[0]))) -
        Math.abs(shortestArc(self.heading, Math.atan2(b[1], b[0]))),
    );
    let best: Point[] | null = null;
    let bestClearance = -Infinity;
    // Which way the U-turn goes: both are tried, but which one is preferred on
    // a tie alternates by bot id — otherwise every bot flies the same shape.
    const sides = this.id % 2 === 0 ? [1, -1] : [-1, 1];
    for (const dir of aligned) {
      for (const side of sides) {
        const plan = excursion(origin, dir, side);
        const clearance = planClearance(plan, sight);
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = plan;
        }
      }
    }
    // Scored raw (above) but flown clamped: the CHOICE must see that a lobe
    // reaches past the edge, while the waypoints actually followed must stay
    // reachable — the barrier would pin the head at an out-of-arena target,
    // which is never "reached", and the run would never end.
    this.plan = (best ?? []).map((point) =>
      clampToArena(point, sight.arenaSizeWU, BALANCE.bots.wallMarginWU),
    );
    this.index = 0;
    this.planOrigin = origin;
    this.committed = false;
  }

  /**
   * The point to steer at right now: the next unreached waypoint, or — once
   * the excursion is flown (or abandoned) — the live way back onto own land.
   */
  private currentTarget(self: BotSelf, arenaSizeWU: number): Point | null {
    while (this.index < this.plan.length) {
      const waypoint = this.plan[this.index];
      if (waypoint === undefined) break;
      if (Math.hypot(waypoint[0] - self.x, waypoint[1] - self.y) > WAYPOINT_REACH_WU) {
        return waypoint;
      }
      this.index += 1;
    }
    return reentryTarget(self, arenaSizeWU);
  }
}
