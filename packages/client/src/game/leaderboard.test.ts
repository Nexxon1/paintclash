import type { LeaderboardRow } from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { PALETTE_SLOTS, PALETTE_TIERS, SELF_COLOR_CSS } from './colors.js';
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
    expect(view[0]?.color).toBe('hsl(52, 65%, 61%)'); // id 2 → palette slot 13
  });

  it('numbers rows whose swatches read as the same color', () => {
    // The palette (ticket 21) gives every id that can be live at once its own
    // color, so no ordinary pair collides any more. It encodes SLOTS × TIERS
    // appearances; the first id past that repeats id 1 exactly, and carrying
    // the discriminator for that case is the whole reason it still exists.
    const wrapped = 1 + PALETTE_SLOTS * PALETTE_TIERS;
    const view = leaderboardView(
      [row(1, 1, 5, 'Max'), row(2, wrapped, 4, 'Max'), row(3, 2, 3, 'Eve')],
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
