/**
 * Death detection (spec §2.1, tickets 05 + 07): trail cuts and head-on
 * collisions, judged live against one post-movement state AND — kill-
 * fairness with rewind (ADR-0003) — from each acting player's lagged view
 * of the others. Pure query over player views: nothing here touches state,
 * RNG or the clock; callers apply the returned deaths afterwards.
 *
 * Resolution order inside one tick:
 *
 *   1. Trail cuts, live — every head against every live trail (foreign AND
 *      own). All cuts count, even by a head that dies itself this tick
 *      (simultaneity). The two are judged by different geometry since ticket
 *      19: a FOREIGN trail is cut on proximity (the rendered band is the kill
 *      zone), the OWN one only where this tick's movement actually crosses it.
 *   1b. Trail cuts, rewound — an actor's head against the trail their
 *      screen showed. Same-generation viewed trails are subsets of the
 *      live ones (see history.ts), so this only ever consults trails RESET
 *      since the viewed tick: the "I cut it before they reached home" race
 *      the rewind exists for.
 *   2. Head-on, live — only among players NOT killed by a cut: a trail
 *      always ends glued to its owner's head, so chasing someone down on
 *      their own line is a cut kill and must not drag the chaser into a
 *      "head-on" death against the freshly cut victim. Safe = standing on
 *      own land (real inside-ness — the one-tick post-enclosure grace of
 *      ticket 06 is gone).
 *   2b. Head-on, rewound — an actor's head against the pose their screen
 *      showed; the viewed player's shield is their safety AT that tick.
 *
 * Within each pass every check runs against the same pre-death state and
 * victims are only marked, never removed — the tick stays order-independent
 * up to the deterministic player order.
 */

import { BALANCE, type DeathCause, type Point } from '@paintclash/shared';

import { segmentDistanceSq, segmentsProperlyCross } from './geometry.js';
import type { RewoundView } from './history.js';
import type { PlayerSim } from './state.js';

export interface Death {
  victimId: number;
  /** Who caused it — the cutting/surviving head; the victim for a self-cut. */
  killerId: number;
  cause: DeathCause;
}

/** What judgment needs beyond the players: safety verdicts and rewound views. */
export interface DeathContext {
  /**
   * Ids of the players standing on their own land after this tick's movement
   * — the head-on shield (spec §2.1). Computed by `step`, which already
   * decides inside-ness for the trail bookkeeping.
   */
  safeIds: ReadonlySet<number>;
  /** How `actor`'s screen showed `target`, or null to judge live only. */
  viewedBy(actor: PlayerSim, target: PlayerSim): RewoundView | null;
  /**
   * Where `p`'s head stood BEFORE this tick's movement — the start of the
   * movement segment the self-cut test judges (ticket 19). Total, so that no
   * caller has to invent an answer for a player it is passing in anyway; the
   * safe answer where one is somehow unknown is the current pose, whose
   * zero-length segment crosses nothing.
   *
   * Only the LIVE self-cut needs it. A rewound self-cut does not exist: a
   * pilot sees their own head live (ADR-0003), so the rewound pass below
   * judges an actor against OTHER players' trails only.
   */
  movedFrom(p: PlayerSim): Point;
}

const RADIUS_WU = BALANCE.trail.collisionRadiusWU;
/** Two heads of collision radius r touch at center distance 2r. */
const HEAD_ON_DIST_SQ = (2 * RADIUS_WU) ** 2;

/**
 * Does a head at (x, y) touch a FOREIGN trail polyline? Proximity within the
 * collision radius: the rendered band is the kill zone. Tested in full —
 * including the piece glued to their owner's head, which is what makes frontal
 * contact with a trailing player a cut and keeps the pure head-on pass for the
 * 0.5–1 WU proximity band.
 */
function headCutsTrail(x: number, y: number, trail: readonly Point[]): boolean {
  const radiusSq = RADIUS_WU * RADIUS_WU;
  for (let i = trail.length - 1; i > 0; i--) {
    const a = trail[i - 1];
    const b = trail[i];
    if (a === undefined || b === undefined) continue;
    if (segmentDistanceSq(x, y, a, b) <= radiusSq) return true;
  }
  return false;
}

/**
 * Does this tick's movement cut the player's OWN trail (ticket 19)? A line
 * crossing, not a proximity test: the segment `from` → head dies exactly where
 * it transversally crosses an earlier own segment (see
 * `segmentsProperlyCross` for what "transversally" buys — the glued tip, wall
 * slides and grazes all fall out of it, so no grace window is needed).
 *
 * The trail's LAST segment is skipped: `trackTrail` already appended this
 * tick's head, so that segment either IS the movement segment or is the
 * straight run containing it (`appendTrailPoint` extends collinear motion in
 * place). Nothing crosses itself, and the segment before it shares the joint
 * they were built from.
 */
function crossesOwnTrail(p: PlayerSim, from: Point): boolean {
  const to: Point = [p.x, p.y];
  for (let i = 1; i < p.trail.length - 1; i++) {
    const a = p.trail[i - 1];
    const b = p.trail[i];
    if (a === undefined || b === undefined) continue;
    if (segmentsProperlyCross(from, to, a, b)) return true;
  }
  return false;
}

/**
 * All deaths of one tick, judged against the given (post-movement) player
 * views plus each actor's rewound view of the others. Deterministic:
 * victims appear in player order per pass, first killer in player order
 * wins the credit.
 */
export function detectDeaths(players: readonly PlayerSim[], ctx: DeathContext): Death[] {
  const deaths: Death[] = [];
  const dead = new Set<number>();
  const mark = (victimId: number, killerId: number, cause: DeathCause): void => {
    if (dead.has(victimId)) return;
    dead.add(victimId);
    deaths.push({ victimId, killerId, cause });
  };

  for (const owner of players) {
    if (owner.trail.length < 2) continue;
    for (const head of players) {
      const cuts =
        head === owner
          ? crossesOwnTrail(owner, ctx.movedFrom(owner))
          : headCutsTrail(head.x, head.y, owner.trail);
      if (cuts) {
        mark(owner.id, head.id, 'trailCut');
        break;
      }
    }
  }

  // Rewound cuts (ticket 07): the trail the actor SAW — reset since their
  // viewed tick, so the live pass above could not have judged it.
  for (const actor of players) {
    for (const owner of players) {
      if (owner === actor) continue;
      const view = ctx.viewedBy(actor, owner);
      if (!view?.trail) continue;
      if (headCutsTrail(actor.x, actor.y, view.trail)) {
        mark(owner.id, actor.id, 'trailCut');
      }
    }
  }

  // Cut victims are dead for the head-on passes; head-on deaths do NOT mask
  // each other (three heads meeting in one spot all die together).
  const cutDead = new Set(dead);
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    if (a === undefined || cutDead.has(a.id)) continue;
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j];
      if (b === undefined || cutDead.has(b.id)) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy > HEAD_ON_DIST_SQ) continue;
      if (!ctx.safeIds.has(a.id)) mark(a.id, b.id, 'headOn');
      if (!ctx.safeIds.has(b.id)) mark(b.id, a.id, 'headOn');
    }
  }

  // Rewound head-on (ticket 07): the actor's head touched where their
  // screen showed an opponent. The viewed pose carries its own-tick shield;
  // the actor's shield is their live one.
  for (const actor of players) {
    if (cutDead.has(actor.id)) continue;
    for (const other of players) {
      if (other === actor || cutDead.has(other.id)) continue;
      const view = ctx.viewedBy(actor, other);
      if (!view) continue;
      const dx = actor.x - view.x;
      const dy = actor.y - view.y;
      if (dx * dx + dy * dy > HEAD_ON_DIST_SQ) continue;
      if (!view.safe) mark(other.id, actor.id, 'headOn');
      if (!ctx.safeIds.has(actor.id)) mark(actor.id, other.id, 'headOn');
    }
  }
  return deaths;
}
