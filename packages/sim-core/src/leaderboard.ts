/**
 * The global live ranking (spec §2.5, CONTEXT: Leaderboard) — derived state,
 * never stored: the metric is exclusively the share of the map, so it is a
 * pure function of the territories the sim already holds (ADR-0004: computed
 * live from memory, no persistence).
 *
 * Who gets to SEE which rows (top N + the own one) is the server's call —
 * this is the whole, recipient-independent table.
 */

import { LEADERBOARD_PERCENT_SCALE } from '@paintclash/shared';

import { territoryArea } from './geometry.js';
import type { SimState } from './state.js';

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
  const arenaArea = state.arenaSizeWU * state.arenaSizeWU;
  return state.players
    .map((p) => ({ playerId: p.id, areaPct: (territoryArea(p.territory) / arenaArea) * 100 }))
    .sort(
      (a, b) =>
        Math.round(b.areaPct * LEADERBOARD_PERCENT_SCALE) -
          Math.round(a.areaPct * LEADERBOARD_PERCENT_SCALE) || a.playerId - b.playerId,
    )
    .map((entry, i) => ({ playerId: entry.playerId, rank: i + 1, areaPct: entry.areaPct }));
}
