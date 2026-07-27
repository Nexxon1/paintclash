/**
 * HUD view of the global ranking (spec §2.5): what the DOM has to paint, with
 * every display decision already made — the swatch color, the own-row
 * highlight, the percent text, and the discriminator that keeps two players
 * apart when their swatches read as the same color.
 *
 * Pure: the rows come from the server, the colors from `colors.ts`. The DOM
 * side (`render/hud.ts`) only stamps this out.
 */

import type { LeaderboardRow } from '@paintclash/protocol';
import { BALANCE } from '@paintclash/shared';

import { playerCssColor, sameShownColor } from './colors.js';

/** One rendered leaderboard line. */
export interface LeaderboardRowView {
  rank: number;
  playerId: number;
  /** Name as shown — carries the discriminator when swatches collide. */
  label: string;
  /** CSS color of the swatch. */
  color: string;
  percentText: string;
  /** The recipient's own row (spec §2.5: highlighted). */
  isSelf: boolean;
}

/** German percent, at the resolution the wire carries (~0,09 % per block). */
function formatPercent(areaPct: number): string {
  return `${areaPct.toFixed(BALANCE.leaderboard.percentDecimals).replace('.', ',')} %`;
}

/**
 * Per row, the 1-based position within its color group, or `null` when the
 * row's color is unique on the board. Groups form greedily in board order,
 * so the numbering is stable while the ranking is.
 */
function discriminators(playerIds: readonly number[], selfId: number | null): (number | null)[] {
  const groups: { playerId: number; rows: number[] }[] = [];
  playerIds.forEach((playerId, i) => {
    const group = groups.find((candidate) => sameShownColor(candidate.playerId, playerId, selfId));
    if (group) group.rows.push(i);
    else groups.push({ playerId, rows: [i] });
  });
  const numbers: (number | null)[] = playerIds.map(() => null);
  for (const { rows } of groups) {
    if (rows.length < 2) continue;
    rows.forEach((rowIndex, i) => {
      numbers[rowIndex] = i + 1;
    });
  }
  return numbers;
}

/** Turn one server board into the lines the HUD paints. */
export function leaderboardView(
  rows: readonly LeaderboardRow[],
  selfId: number | null,
): LeaderboardRowView[] {
  const numbers = discriminators(
    rows.map((r) => r.playerId),
    selfId,
  );
  return rows.map((r, i) => {
    const number = numbers[i];
    return {
      rank: r.rank,
      playerId: r.playerId,
      label: number === null || number === undefined ? r.name : `${r.name} ‹${String(number)}›`,
      color: playerCssColor(r.playerId, selfId),
      percentText: formatPercent(r.areaPct),
      isSelf: r.playerId === selfId,
    };
  });
}
