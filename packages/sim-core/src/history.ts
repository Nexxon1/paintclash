/**
 * Rewind history (ticket 07, ADR-0003): a rolling per-player window of
 * post-tick poses plus the trails reset inside that window. `viewedBy`
 * answers the one question kill-fairness needs — "what did the acting
 * player's screen show of this opponent?" — without the sim ever copying a
 * live trail:
 *
 * - A trail only ever grows at its head-glued tip (`appendTrailPoint`
 *   pushes, or extends the last point in place), so the trail of any past
 *   tick within the SAME trail generation is a geometric subset of the live
 *   one — a live-pass miss is conclusive and no rewound trail is needed.
 * - Only a RESET (fill or death) removes geometry. `retireTrail` then keeps
 *   the dying array by reference — it is never mutated again — and the past
 *   trail is rebuilt as its settled-point prefix plus the historical head
 *   as tip (points before the last are immutable once laid).
 *
 * Everything here is plain deterministic state: recorded by `step`, cloned
 * and hashed with it, replayed from the same inputs (spec §9.2).
 */

import { LIMITS, type Point } from '@paintclash/shared';

import type { PlayerSim, PoseHistoryEntry } from './state.js';

/** An opponent as the acting player saw them, `viewDelayTicks` ago. */
export interface RewoundView {
  x: number;
  y: number;
  /** Stood on own land at the viewed tick (head-on shield, spec §2.1). */
  safe: boolean;
  /**
   * The viewed trail — only when it can hit where the live trail cannot,
   * i.e. after a reset since the viewed tick. `null` otherwise: the live
   * trail is a superset then, so the live pass already judged it.
   */
  trail: readonly Point[] | null;
}

/**
 * Reset the player's trail, keeping the old array for rewound judgment —
 * the fill-reset path: the runner lives on, so a lagged actor's cut of the
 * just-vanished trail must still be judgeable. The epoch bump is what tells
 * `viewedBy` that history entries no longer describe the live trail.
 * (Death resets do NOT retire: a death purges the victim's whole rewind
 * past instead — see `applyDeaths` — so one life can never die twice.)
 */
export function retireTrail(p: PlayerSim): void {
  if (p.trail.length >= 2) {
    p.retiredTrails.push({ epoch: p.trailEpoch, points: p.trail });
  }
  p.trailEpoch += 1;
  p.trail = [];
}

/**
 * Record every player's post-tick pose under the just-completed tick and
 * trim to the rewind window. `safeIds` holds the post-death inside-own-land
 * verdicts. Retired trails whose epoch no history entry references any more
 * are unreachable — dropped.
 */
export function recordHistory(
  players: readonly PlayerSim[],
  tick: number,
  safeIds: ReadonlySet<number>,
): void {
  for (const p of players) {
    p.history.push({
      tick,
      x: p.x,
      y: p.y,
      safe: safeIds.has(p.id),
      trailLen: p.trail.length,
      trailEpoch: p.trailEpoch,
    });
    if (p.history.length > LIMITS.rewindMaxTicks) p.history.shift();
    if (p.retiredTrails.length > 0) {
      p.retiredTrails = p.retiredTrails.filter((r) =>
        p.history.some((h) => h.trailEpoch === r.epoch),
      );
    }
  }
}

/** The entry describing `tick`, or null when outside the recorded window. */
function entryAt(p: PlayerSim, tick: number): PoseHistoryEntry | null {
  for (const entry of p.history) {
    if (entry.tick === tick) return entry;
  }
  return null;
}

/**
 * How `actor`'s screen showed `target` when the input judged at
 * `currentTick` was made — or null when there is nothing to rewind (no
 * view lag, or the viewed tick predates the window/join).
 */
export function viewedBy(
  actor: PlayerSim,
  target: PlayerSim,
  currentTick: number,
): RewoundView | null {
  if (actor.viewDelayTicks <= 0) return null;
  const entry = entryAt(target, currentTick - actor.viewDelayTicks);
  if (!entry) return null;
  let trail: readonly Point[] | null = null;
  if (entry.trailEpoch !== target.trailEpoch && entry.trailLen >= 2) {
    // The entry itself keeps its epoch's trail alive (recordHistory's GC),
    // and a trail that reached `trailLen ≥ 2` was necessarily captured when
    // it was retired — so the lookup always finds it. Settled prefix + the
    // historical head as tip = the trail of that tick (only the glued tip
    // ever moved afterwards).
    const retired = target.retiredTrails.find((r) => r.epoch === entry.trailEpoch)?.points;
    if (retired) trail = [...retired.slice(0, entry.trailLen - 1), [entry.x, entry.y]];
  }
  return { x: entry.x, y: entry.y, safe: entry.safe, trail };
}
