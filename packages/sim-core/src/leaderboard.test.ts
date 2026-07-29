import { MAP_SHARE_PERCENT_SCALE } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { squareRing } from './geometry.js';
import { standings } from './leaderboard.js';
import { seedRng } from './rng.js';
import type { PlayerSim, SimState } from './state.js';

/** A player owning one square of `half*2` edge length around (cx, cy). */
function owner(id: number, half: number, cx = 50, cy = 50): PlayerSim {
  return {
    id,
    x: 0,
    y: 0,
    heading: 0,
    turn: 0,
    territory: half > 0 ? [[squareRing(cx, cy, half)]] : [],
    trail: [],
    viewDelayTicks: 0,
    trailEpoch: 0,
    retiredTrails: [],
    history: [],
    isBot: false,
    lifeTicks: 0,
    peakPct: 0,
    otherHumanTicks: 0,
  };
}

/**
 * Territories in the sim are pairwise disjoint, so a generated arena must be
 * too: each player owns a square inside its OWN cell of the 10 × 10 grid over
 * the 100 WU arena. Cell index doubles as the (unique, non-contiguous) player
 * id — a grid full of 10 WU squares is the whole map, owned.
 */
function gridOwner(cell: number, edgeWU: number): PlayerSim {
  const cx = (cell % 10) * 10 + 5;
  const cy = Math.floor(cell / 10) * 10 + 5;
  return owner(cell + 1, edgeWU / 2, cx, cy);
}

/** 100 × 100 WU arena = 10 000 WU² — one percent is exactly 100 WU². */
function arenaWith(...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: 100, players };
}

describe('standings (spec §2.5: the metric is exclusively % of the map)', () => {
  it('ranks by area share, biggest first, in percent of the arena', () => {
    // Edges 20/40/10 WU → 400/1600/100 WU² → 4 %, 16 %, 1 % of 10 000 WU².
    const table = standings(arenaWith(owner(1, 10), owner(2, 20), owner(3, 5)));
    expect(table).toEqual([
      { playerId: 2, rank: 1, areaPct: 16 },
      { playerId: 1, rank: 2, areaPct: 4 },
      { playerId: 3, rank: 3, areaPct: 1 },
    ]);
  });

  it('breaks exact ties by player id — spawn blocks are all the same size', () => {
    const table = standings(arenaWith(owner(7, 3), owner(2, 3), owner(5, 3)));
    expect(table.map((s) => s.playerId)).toEqual([2, 5, 7]);
    expect(table.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it('orders shares that LOOK equal by id, not by float noise below the digits', () => {
    // 100 WU² vs 100.0004 WU² — both read 1,00 %, so the rank must not hinge
    // on the invisible remainder (nor on which square the shoelace rounds up).
    const bigger = owner(9, 5);
    bigger.territory = [
      [
        [
          [50, 50],
          [60.00002, 50],
          [60.00002, 60],
          [50, 60],
        ],
      ],
    ];
    expect(standings(arenaWith(bigger, owner(4, 5))).map((s) => s.playerId)).toEqual([4, 9]);
  });

  it('a landless player ranks last with zero percent', () => {
    const table = standings(arenaWith(owner(1, 0), owner(2, 5)));
    expect(table).toEqual([
      { playerId: 2, rank: 1, areaPct: 1 },
      { playerId: 1, rank: 2, areaPct: 0 },
    ]);
  });

  it('an empty arena has an empty ranking', () => {
    expect(standings(arenaWith())).toEqual([]);
  });

  it('a fully owned map is exactly 100 % — the shares are a partition (spec §9.2)', () => {
    const whole = Array.from({ length: 100 }, (_, cell) => gridOwner(cell, 10));
    const total = standings(arenaWith(...whole)).reduce((sum, s) => sum + s.areaPct, 0);
    expect(total).toBeCloseTo(100, 9);
  });

  it('property: shares stay a valid partition and the order is total (spec §9.2)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            cell: fc.integer({ min: 0, max: 99 }),
            edgeWU: fc.integer({ min: 1, max: 10 }),
          }),
          { selector: (c) => c.cell, maxLength: 30 },
        ),
        (cells) => {
          const table = standings(arenaWith(...cells.map((c) => gridOwner(c.cell, c.edgeWU))));
          // Never negative, never more of the map than there is.
          for (const entry of table) expect(entry.areaPct).toBeGreaterThanOrEqual(0);
          const total = table.reduce((sum, s) => sum + s.areaPct, 0);
          expect(total).toBeLessThanOrEqual(100 + 1e-9);
          // Ordinal ranks: N players occupy exactly 1…N.
          expect(table.map((s) => s.rank)).toEqual(cells.map((_, i) => i + 1));
          // Totally ordered by the SHOWN share, equal-looking rows by id —
          // the property that keeps the board from flickering.
          for (let i = 1; i < table.length; i++) {
            const above = table[i - 1];
            const below = table[i];
            if (!above || !below) throw new Error('gap in the table');
            const shownAbove = Math.round(above.areaPct * MAP_SHARE_PERCENT_SCALE);
            const shownBelow = Math.round(below.areaPct * MAP_SHARE_PERCENT_SCALE);
            expect(shownAbove).toBeGreaterThanOrEqual(shownBelow);
            if (shownAbove === shownBelow) {
              expect(above.playerId).toBeLessThan(below.playerId);
            }
          }
        },
      ),
    );
  });
});
