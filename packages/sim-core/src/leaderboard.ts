/**
 * The global live ranking (spec §2.5, CONTEXT: Leaderboard) — derived state,
 * never stored: the metric is exclusively the share of the map, so it is a
 * pure function of the territories the sim already holds (ADR-0004: computed
 * live from memory, no persistence).
 *
 * Who gets to SEE which rows (top N + the own one) is the server's call —
 * this is the whole, recipient-independent table.
 */

import { MAP_SHARE_PERCENT_SCALE, type Territory } from '@paintclash/shared';

import { territoryArea } from './geometry.js';
import type { SimState } from './state.js';

/**
 * Share of the map in percent — the one metric the game ranks on (spec §2.5)
 * and the score's `peakPct` (spec §10.5). Defined once so ranking and score
 * can never disagree about what "12 %" means, and arena-size independent by
 * construction: a private room's 12 % is the public arena's 12 %.
 */
export function mapSharePct(territory: Territory, arenaSizeWU: number): number {
  return (territoryArea(territory) / (arenaSizeWU * arenaSizeWU)) * 100;
}

/** One player's place in the global ranking. */
export interface Standing {
  playerId: number;
  /** 1-based; ordinal, so N players always occupy ranks 1…N. */
  rank: number;
  /** Share of the arena in percent (0…100). */
  areaPct: number;
}

/**
 * Every player, biggest share first.
 *
 * Order is decided on the SHOWN share and ties break by player id. Two
 * reasons, both practical: a fresh arena is one big tie (every start block is
 * the same size), and the shoelace area of two equal squares at different
 * spots differs in the last float bits — ranking on that raw value would let
 * equal-looking rows swap places for no visible reason, and no observer
 * (client, test, replay) could reproduce the order. Rounding first makes the
 * ranking as reproducible as the number the player reads (ADR-0003).
 */
export function standings(state: SimState): Standing[] {
  return state.players
    .map((p) => ({ playerId: p.id, areaPct: mapSharePct(p.territory, state.arenaSizeWU) }))
    .sort(
      (a, b) =>
        Math.round(b.areaPct * MAP_SHARE_PERCENT_SCALE) -
          Math.round(a.areaPct * MAP_SHARE_PERCENT_SCALE) || a.playerId - b.playerId,
    )
    .map((entry, i) => ({ playerId: entry.playerId, rank: i + 1, areaPct: entry.areaPct }));
}
