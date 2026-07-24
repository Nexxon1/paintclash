import { BALANCE, TICK_DT_SEC } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { pointInTerritory, squareRing, territoryArea } from './geometry.js';
import { seedRng } from './rng.js';
import type { PlayerSim, SimState } from './state.js';
import { step } from './step.js';

/**
 * Hand-built player (same seam as death.test.ts): head at (x, y), 6×6 block
 * centered on (blockX, blockY). The fillers below sit one step from re-entry,
 * heading 3π/2 (straight down), their trail already laid as an almost-closed
 * ring — the step under test moves the head back inside and closes the loop.
 */
function player(
  id: number,
  x: number,
  y: number,
  heading: number,
  blockX: number,
  blockY: number,
): PlayerSim {
  return { id, x, y, heading, turn: 0, territory: [[squareRing(blockX, blockY, 3)]], trail: [] };
}

function stateWith(...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: BALANCE.arena.sizeWU, players };
}

/** Filler poised at (100, 103.3) over its (97..103)² block, loop ring laid. */
function fillerWithRing(ring: [number, number][]): PlayerSim {
  const filler = player(1, 100, 103.3, (3 * Math.PI) / 2, 100, 100);
  filler.trail = ring.map(([x, y]) => [x, y]);
  return filler;
}

describe('stealing on fill (spec §2.2, ticket 06)', () => {
  it('a loop enclosing part of a foreign block steals exactly that part', () => {
    // Loop encloses [100..120]×[100..109]; B's block (107..113)² loses its
    // southern strip y ∈ [107..109] (12 WU²) and keeps 24.
    const a = fillerWithRing([
      [102, 100],
      [120, 100],
      [120, 109],
      [100, 109],
      [100, 103.3],
    ]);
    const b = player(2, 110, 107.5, 0, 110, 110); // head inside the enclosure
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.fills).toEqual([1]);
    expect(events.steals).toEqual([2]);
    expect(events.deaths).toEqual([]);
    expect(territoryArea(b.territory)).toBeCloseTo(24, 4);
    expect(pointInTerritory(110, 108, b.territory)).toBe(false);
    expect(pointInTerritory(110, 111, b.territory)).toBe(true);
    // The stolen strip belongs to A now — B's head stands on it, alive:
    // enclosure alone never kills (spec §2.2).
    expect(pointInTerritory(110, 108, a.territory)).toBe(true);
  });

  it('painting a block away entirely is a total-loss death — the own-land head is no reprieve', () => {
    // B parks on its own block the whole time; A's loop swallows all of it.
    const a = fillerWithRing([
      [102, 100],
      [120, 100],
      [120, 120],
      [100, 120],
      [100, 103.3],
    ]);
    const b = player(2, 110, 110, 0, 110, 110);
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.fills).toEqual([1]);
    expect(events.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'totalLoss' }]);
    // A total-loss victim is a death, not a steal survivor.
    expect(events.steals).toEqual([]);
    // A owns the old block spot; B respawned fresh (spec §2.1/2.3).
    expect(pointInTerritory(110, 110, a.territory)).toBe(true);
    const victim = state.players[1];
    if (!victim) throw new Error('victim vanished');
    expect(territoryArea(victim.territory)).toBeCloseTo(BALANCE.spawn.startBlockWU ** 2, 4);
    expect(victim.trail).toHaveLength(0);
    expect(pointInTerritory(victim.x, victim.y, victim.territory)).toBe(true);
  });

  it('one loop can wipe one victim and merely shrink another', () => {
    // Loop encloses [100..120]×[100..115]: B's block (107..113)² vanishes,
    // C's block (107..113)×(114..120) loses only y ∈ [114..115] (6 WU²).
    const a = fillerWithRing([
      [102, 100],
      [120, 100],
      [120, 115],
      [100, 115],
      [100, 103.3],
    ]);
    const b = player(2, 110, 110, 0, 110, 110);
    const c = player(3, 110, 118, 0, 110, 117);
    const state = stateWith(a, b, c);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'totalLoss' }]);
    expect(events.steals).toEqual([3]);
    expect(territoryArea(c.territory)).toBeCloseTo(30, 4);
  });
});
