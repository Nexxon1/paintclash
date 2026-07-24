/**
 * Death detection (spec §2.1, ticket 05): trail cuts and head-on collisions,
 * evaluated simultaneously against one post-movement state. Pure query over
 * player views — ticket 07 (kill-fairness) will call it with *rewound* player
 * poses, so nothing here may touch state, RNG or the clock.
 *
 * Resolution order inside one tick:
 *
 *   1. Trail cuts — every head against every trail (foreign AND own). All
 *      cuts count, even by a head that dies itself this tick (simultaneity).
 *   2. Head-on — only among players NOT killed by a cut in pass 1: a trail
 *      always ends glued to its owner's head, so chasing someone down on
 *      their own line is a cut kill and must not drag the chaser into a
 *      "head-on" death against the freshly cut victim.
 *
 * The passes make the tick order-independent: within each pass every check
 * runs against the same pre-death state, and victims are only marked, never
 * removed. Callers apply the returned deaths afterwards.
 */

import { BALANCE, type DeathCause, type Point } from '@paintclash/shared';

import { segmentDistanceSq } from './geometry.js';
import type { PlayerSim } from './state.js';

export interface Death {
  victimId: number;
  /** Who caused it — the cutting/surviving head; the victim for a self-cut. */
  killerId: number;
  cause: DeathCause;
}

const RADIUS_WU = BALANCE.trail.collisionRadiusWU;
/** Two heads of collision radius r touch at center distance 2r. */
const HEAD_ON_DIST_SQ = (2 * RADIUS_WU) ** 2;

/**
 * Does a head at (x, y) touch this trail polyline? `graceWU` skips that much
 * path length from the trail's head end before testing (self-cut only, see
 * BALANCE.trail.selfCutGraceWU; foreign trails are tested in full —
 * including the piece glued to their owner's head, which is what makes
 * frontal contact with a trailing player a cut and keeps the pure head-on
 * pass for the 0.5–1 WU proximity band).
 */
function headCutsTrail(x: number, y: number, trail: readonly Point[], graceWU: number): boolean {
  const radiusSq = RADIUS_WU * RADIUS_WU;
  let remainingGrace = graceWU;
  for (let i = trail.length - 1; i > 0; i--) {
    const a = trail[i - 1];
    let b = trail[i];
    if (a === undefined || b === undefined) continue;
    if (remainingGrace > 0) {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length <= remainingGrace) {
        remainingGrace -= length;
        continue;
      }
      // Straight runs compact to one long segment — cut it at the grace
      // boundary instead of skipping it whole.
      const t = remainingGrace / length;
      b = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t];
      remainingGrace = 0;
    }
    if (segmentDistanceSq(x, y, a, b) <= radiusSq) return true;
  }
  return false;
}

/**
 * All deaths of one tick, evaluated against the given (post-movement) player
 * views. Deterministic: victims appear in player order per pass, first
 * killer in player order wins the credit.
 */
export function detectDeaths(players: readonly PlayerSim[]): Death[] {
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
      const grace = head === owner ? BALANCE.trail.selfCutGraceWU : 0;
      if (headCutsTrail(head.x, head.y, owner.trail, grace)) {
        mark(owner.id, head.id, 'trailCut');
        break;
      }
    }
  }

  // Cut victims are dead for this pass; head-on deaths do NOT mask each
  // other (three heads meeting in one spot all die together).
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
      // Safe = standing on own land. Post-movement, "outside ⇔ trail
      // exists" holds for landed players (trackTrail's own verdict, so the
      // two passes can never disagree); the landless are always outside.
      const aSafe = a.territory.length > 0 && a.trail.length === 0;
      const bSafe = b.territory.length > 0 && b.trail.length === 0;
      if (!aSafe) mark(a.id, b.id, 'headOn');
      if (!bSafe) mark(b.id, a.id, 'headOn');
    }
  }
  return deaths;
}
