/**
 * Score (spec §2.5/§10.5, CONTEXT: Score) — the personal performance number,
 * computed from the counters `step` accumulates over one life.
 *
 * Two consumers share this one formula on purpose (ADR-0002): the client
 * paints a LIVE estimate on the HUD while the life runs, and the same function
 * turns the life's closing counters into the final number. A second
 * implementation anywhere would be a second balance.
 *
 * Nothing here is persisted (ADR-0004): the score is personal, the records
 * that keep it live in the browser (ADR-0006 seam 4).
 */

import { BALANCE, type LifeCounters } from '@paintclash/shared';

import type { PlayerSim } from './state.js';

export type { LifeCounters };

/** One player's life counters — what the wire carries, plus whose life it is. */
export interface LifeStats extends LifeCounters {
  playerId: number;
}

/** Project a player's life counters — the shape server and wire carry. */
export function lifeStats(p: PlayerSim): LifeStats {
  return {
    playerId: p.id,
    peakPct: p.peakPct,
    lifeTicks: p.lifeTicks,
    // A player who has not lived a tick has no company average yet.
    avgOtherHumans: p.lifeTicks > 0 ? p.otherHumanTicks / p.lifeTicks : 0,
  };
}

/**
 * The formula's inputs (spec §10.5) — the counters with time in SECONDS, the
 * unit the score is defined in. Both callers convert at their own boundary:
 * the sim's ticks × the fixed dt.
 */
export interface LifeScoreInput extends Omit<LifeCounters, 'lifeTicks'> {
  survivalSec: number;
}

/**
 * `round(peakPct × √survivalSec × (1 + 0,25 × ØotherHumans) × 10)`.
 *
 * The negative/non-finite clamps are not sim guards — the sim can only ever
 * hand up non-negative counters. They exist because the CLIENT feeds this the
 * same numbers advanced on its own tick clock; a bad frame must show a zero,
 * never a `NaN` on the HUD.
 */
export function lifeScore({ peakPct, survivalSec, avgOtherHumans }: LifeScoreInput): number {
  const value =
    Math.max(0, peakPct) *
    Math.sqrt(Math.max(0, survivalSec)) *
    (1 + BALANCE.score.humanBonus * Math.max(0, avgOtherHumans)) *
    BALANCE.score.scale;
  return Number.isFinite(value) ? Math.round(value) : 0;
}
