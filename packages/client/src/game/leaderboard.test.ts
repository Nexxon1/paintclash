import type { LeaderboardRow } from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { SELF_COLOR_CSS } from './colors.js';
import { leaderboardView } from './leaderboard.js';

function row(rank: number, playerId: number, areaPct: number, name: string): LeaderboardRow {
  return { rank, playerId, areaPct, name };
}

describe('leaderboard view (spec §2.5)', () => {
  it('shows rank, name, swatch and share, and marks the own row', () => {
    const view = leaderboardView([row(1, 2, 12.5, 'Bo'), row(2, 3, 0.09, 'Ada')], 3);
    expect(
      view.map(({ rank, playerId, label, percentText, isSelf }) => ({
        rank,
        playerId,
        label,
        percentText,
        isSelf,
      })),
    ).toEqual([
      { rank: 1, playerId: 2, label: 'Bo', percentText: '12,50 %', isSelf: false },
      { rank: 2, playerId: 3, label: 'Ada', percentText: '0,09 %', isSelf: true },
    ]);
    // The own swatch is the reserved blue; everyone else gets their hue.
    expect(view[1]?.color).toBe(SELF_COLOR_CSS);
    expect(view[0]?.color).toBe('hsl(85, 65%, 55%)'); // 2 × 0.618034 → 0.236068
  });

  it('numbers rows whose swatches read as the same color', () => {
    // Ids 1 and 11 land 0.1° apart (id 1 is bumped off the reserved blue) —
    // two indistinguishable swatches, so both rows get a discriminator.
    const view = leaderboardView(
      [row(1, 1, 5, 'Max'), row(2, 11, 4, 'Max'), row(3, 2, 3, 'Eve')],
      9,
    );
    expect(view.map((r) => r.label)).toEqual(['Max ‹1›', 'Max ‹2›', 'Eve']);
  });

  it('leaves distinct colors unnumbered even when the names match', () => {
    const view = leaderboardView([row(1, 2, 5, 'Max'), row(2, 3, 4, 'Max')], 9);
    expect(view.map((r) => r.label)).toEqual(['Max', 'Max']);
  });

  it('has nothing to show before the first board arrives', () => {
    expect(leaderboardView([], 1)).toEqual([]);
  });
});
