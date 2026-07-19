import { BALANCE, TICK_DT_SEC } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { seedRng } from './rng.js';
import { createSimState, type PlayerSim, type SimState } from './state.js';
import { step } from './step.js';

/** A hand-built player literal — the state shape is part of the public seam. */
function playerAt(
  id: number,
  x: number,
  y: number,
  heading: number,
  turn: -1 | 0 | 1 = 0,
): PlayerSim {
  return { id, x, y, heading, turn, blockCx: x, blockCy: y };
}

function stateWith(...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: BALANCE.arena.sizeWU, players };
}

const TURN_RAD_PER_TICK = (BALANCE.movement.turnRateDegPerSec * Math.PI) / 180 / 20;
const STEP_WU = BALANCE.movement.speedWuPerSec * TICK_DT_SEC; // 0.45 WU per tick

describe('movement', () => {
  it('moves the head 0.45 WU along its heading per 50 ms tick', () => {
    const state = stateWith(playerAt(1, 100, 100, 0));
    step(state, {}, TICK_DT_SEC);
    expect(state.players[0]?.x).toBeCloseTo(100.45, 10);
    expect(state.players[0]?.y).toBeCloseTo(100, 10);
    expect(state.tick).toBe(1);
  });

  it('turns at most 16° per tick (320°/s clamped)', () => {
    const state = stateWith(playerAt(1, 100, 100, 0, 1));
    step(state, {}, TICK_DT_SEC);
    expect(state.players[0]?.heading).toBeCloseTo(TURN_RAD_PER_TICK, 10);
    // Speed stays constant while turning.
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    const dist = Math.hypot(p.x - 100, p.y - 100);
    expect(dist).toBeCloseTo(STEP_WU, 10);
  });

  it('keeps turning with the last received intent until a new one arrives', () => {
    const state = stateWith(playerAt(1, 100, 100, 0));
    step(state, { turns: [{ id: 1, turn: 1 }] }, TICK_DT_SEC);
    step(state, {}, TICK_DT_SEC); // no fresh intent — last one persists
    expect(state.players[0]?.heading).toBeCloseTo(2 * TURN_RAD_PER_TICK, 10);
    step(state, { turns: [{ id: 1, turn: 0 }] }, TICK_DT_SEC);
    expect(state.players[0]?.heading).toBeCloseTo(2 * TURN_RAD_PER_TICK, 10);
  });

  it('applies only the last intent of a tick (coalescing)', () => {
    const state = stateWith(playerAt(1, 100, 100, 0));
    step(
      state,
      {
        turns: [
          { id: 1, turn: -1 },
          { id: 1, turn: 1 },
        ],
      },
      TICK_DT_SEC,
    );
    expect(state.players[0]?.heading).toBeCloseTo(TURN_RAD_PER_TICK, 10);
  });

  it('ignores intents for unknown players', () => {
    const state = stateWith(playerAt(1, 100, 100, 0));
    expect(() => {
      step(state, { turns: [{ id: 99, turn: 1 }] }, TICK_DT_SEC);
    }).not.toThrow();
  });

  it('wraps the heading into [0, 2π)', () => {
    const state = stateWith(playerAt(1, 100, 100, 0.1, -1));
    step(state, {}, TICK_DT_SEC);
    const heading = state.players[0]?.heading ?? NaN;
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(2 * Math.PI);
    expect(heading).toBeCloseTo(0.1 - TURN_RAD_PER_TICK + 2 * Math.PI, 10);
  });
});

describe('soft barrier (spec §2.4: slide along the wall, no edge death)', () => {
  it('clamps head-on movement at the wall', () => {
    const state = stateWith(playerAt(1, 0.2, 100, Math.PI));
    step(state, {}, TICK_DT_SEC);
    expect(state.players[0]?.x).toBe(0);
    expect(state.players[0]?.y).toBeCloseTo(100, 10);
  });

  it('slides along the wall on diagonal impact', () => {
    const state = stateWith(playerAt(1, 0.1, 100, (3 * Math.PI) / 4));
    step(state, {}, TICK_DT_SEC);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    expect(p.x).toBe(0);
    // The along-wall velocity component survives: sin(3π/4) · 0.45 WU.
    expect(p.y).toBeCloseTo(100 + STEP_WU * Math.sin((3 * Math.PI) / 4), 10);
    // Still alive, heading untouched — the wall never kills.
    expect(p.heading).toBeCloseTo((3 * Math.PI) / 4, 10);
  });

  it('clamps to the far wall too', () => {
    const size = BALANCE.arena.sizeWU;
    const state = stateWith(playerAt(1, size - 0.1, size - 0.1, Math.PI / 4));
    step(state, {}, TICK_DT_SEC);
    expect(state.players[0]?.x).toBe(size);
    expect(state.players[0]?.y).toBe(size);
  });
});

describe('spawn (spec §2.3)', () => {
  it('spawns a joining player on a start block fully inside the arena', () => {
    const state = createSimState(7);
    step(state, { joins: [42] }, TICK_DT_SEC);
    const p = state.players.find((q) => q.id === 42);
    if (!p) throw new Error('player did not spawn');
    const half = BALANCE.spawn.startBlockWU / 2;
    expect(p.blockCx).toBeGreaterThanOrEqual(half);
    expect(p.blockCx).toBeLessThanOrEqual(BALANCE.arena.sizeWU - half);
    expect(p.blockCy).toBeGreaterThanOrEqual(half);
    expect(p.blockCy).toBeLessThanOrEqual(BALANCE.arena.sizeWU - half);
    // The head spawns on its block center and has moved exactly one tick since.
    expect(Math.hypot(p.x - p.blockCx, p.y - p.blockCy)).toBeCloseTo(STEP_WU, 10);
    expect(p.heading).toBeGreaterThanOrEqual(0);
    expect(p.heading).toBeLessThan(2 * Math.PI);
  });

  it('respects the 25 WU minimum distance to enemies when space allows', () => {
    const state = createSimState(3);
    step(state, { joins: [1] }, TICK_DT_SEC);
    step(state, { joins: [2] }, TICK_DT_SEC);
    const [a, b] = state.players;
    if (!a || !b) throw new Error('players did not spawn');
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    expect(dist).toBeGreaterThanOrEqual(BALANCE.spawn.minDistanceWU);
  });

  it('falls back to the best available spot under crowding instead of failing', () => {
    // A 20-WU arena cannot honor 25 WU distance — best effort must still spawn.
    const state = createSimState(5, 20);
    step(state, { joins: [1] }, TICK_DT_SEC);
    step(state, { joins: [2] }, TICK_DT_SEC);
    expect(state.players).toHaveLength(2);
  });

  it('spawns deterministically for a given seed', () => {
    const a = createSimState(11);
    const b = createSimState(11);
    step(a, { joins: [1, 2, 3] }, TICK_DT_SEC);
    step(b, { joins: [1, 2, 3] }, TICK_DT_SEC);
    expect(a.players).toEqual(b.players);
    expect(a.rng).toBe(b.rng);
  });

  it('ignores a join for an id that is already in the arena', () => {
    const state = createSimState(1);
    step(state, { joins: [1] }, TICK_DT_SEC);
    const before = state.players[0];
    step(state, { joins: [1] }, TICK_DT_SEC);
    expect(state.players).toHaveLength(1);
    expect(state.players[0]?.blockCx).toBe(before?.blockCx);
  });
});

describe('leave', () => {
  it('removes the player and leaves everyone else untouched', () => {
    const state = stateWith(playerAt(1, 50, 50, 0), playerAt(2, 150, 150, 0));
    step(state, { leaves: [1] }, TICK_DT_SEC);
    expect(state.players.map((p) => p.id)).toEqual([2]);
  });

  it('tolerates a leave for an unknown id', () => {
    const state = stateWith(playerAt(1, 50, 50, 0));
    expect(() => {
      step(state, { leaves: [99] }, TICK_DT_SEC);
    }).not.toThrow();
    expect(state.players).toHaveLength(1);
  });
});
