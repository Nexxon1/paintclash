import { BALANCE, TICK_DT_SEC, type Territory } from '@paintclash/shared';
import fc from 'fast-check';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';

import { pointInTerritory, squareRing, territoryArea } from './geometry.js';
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
  return { id, x, y, heading, turn, territory: [[squareRing(x, y, 3)]], trail: [] };
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
  it('spawns a joining player on a 6×6 start block inside the arena', () => {
    const state = createSimState(7);
    step(state, { joins: [42] }, TICK_DT_SEC);
    const p = state.players.find((q) => q.id === 42);
    if (!p) throw new Error('player did not spawn');
    expect(territoryArea(p.territory)).toBeCloseTo(BALANCE.spawn.startBlockWU ** 2, 6);
    for (const poly of p.territory) {
      for (const ring of poly) {
        for (const [x, y] of ring) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(BALANCE.arena.sizeWU);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(BALANCE.arena.sizeWU);
        }
      }
    }
    // The head starts inside its own block (one tick of movement is < half).
    expect(pointInTerritory(p.x, p.y, p.territory)).toBe(true);
    expect(p.trail).toHaveLength(0);
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
    // Even crowded, start blocks never overlap: total owned ≤ arena.
    const total = state.players.reduce((sum, p) => sum + territoryArea(p.territory), 0);
    expect(total).toBeLessThanOrEqual(20 * 20 + 1e-6);
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
    const before = territoryArea(state.players[0]?.territory ?? []);
    step(state, { joins: [1] }, TICK_DT_SEC);
    expect(state.players).toHaveLength(1);
    expect(territoryArea(state.players[0]?.territory ?? [])).toBe(before);
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

/** A player whose territory is the (97..103)² block, wherever the head is. */
function playerOnBlock(id: number, x: number, y: number, heading: number): PlayerSim {
  return { ...playerAt(id, x, y, heading), territory: [[squareRing(100, 100, 3)]] };
}

describe('trail (spec §2.1: outside = trail, inside = safespace)', () => {
  it('starts a trail on leaving the territory, seeded with the last inside pose', () => {
    // Head near the right edge of the (97..103)² block, moving right:
    // leaves it on the first tick.
    const state = stateWith(playerOnBlock(1, 102.8, 100, 0));
    step(state, {}, TICK_DT_SEC); // 103.25 — outside
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    expect(p.trail.length).toBeGreaterThanOrEqual(2);
    expect(p.trail[0]).toEqual([102.8, 100]); // the last inside pose
    const last = p.trail[p.trail.length - 1];
    expect(last?.[0]).toBeCloseTo(103.25, 10);
  });

  it('draws no trail while inside the own territory', () => {
    const state = stateWith(playerAt(1, 100, 100, 0));
    step(state, {}, TICK_DT_SEC);
    expect(state.players[0]?.trail).toHaveLength(0);
  });

  it('extends the trail while outside (collinear run stays two points)', () => {
    const state = stateWith(playerOnBlock(1, 102.8, 100, 0));
    step(state, {}, TICK_DT_SEC);
    step(state, {}, TICK_DT_SEC);
    step(state, {}, TICK_DT_SEC);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    expect(p.trail).toHaveLength(2); // straight line — compacted
    expect(p.trail[1]?.[0]).toBeCloseTo(104.15, 10);
  });

  it('a landless player draws no trail (pathological crowding)', () => {
    const state = stateWith({ ...playerAt(1, 100, 100, 0), territory: [] });
    step(state, {}, TICK_DT_SEC);
    expect(state.players[0]?.trail).toHaveLength(0);
  });
});

describe('loop close → fill (spec §2.2)', () => {
  it('re-entering the territory captures the enclosed area and resets the trail', () => {
    const player = playerOnBlock(1, 102, 103.4, (3 * Math.PI) / 2); // heading straight down
    player.trail = [
      [102, 100],
      [106, 100],
      [106, 106],
      [102, 106],
      [102, 103.4],
    ];
    const state = stateWith(player);
    const events = step(state, {}, TICK_DT_SEC); // y: 103.4 → 102.95, inside
    expect(events.fills).toEqual([1]);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    expect(p.trail).toHaveLength(0);
    // Loop rectangle [102..106]×[100..106] = 24, overlap with block = 3.
    expect(territoryArea(p.territory)).toBeCloseTo(36 + 21, 4);
    expect(pointInTerritory(105, 104, p.territory)).toBe(true);
  });

  it('a sliver loop fires the fill event but keeps the territory (spec §2.2 floor)', () => {
    const player = playerOnBlock(1, 103.3, 100, Math.PI); // just outside, heading back in
    player.trail = [
      [102.9, 100],
      [103.3, 100.01],
    ];
    const state = stateWith(player);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.fills).toEqual([1]);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    expect(p.trail).toHaveLength(0);
    expect(territoryArea(p.territory)).toBeCloseTo(36, 6);
  });

  it('the capture never takes foreign land (stealing is ticket 06)', () => {
    const player = playerOnBlock(1, 102, 103.4, (3 * Math.PI) / 2);
    player.trail = [
      [102, 100],
      [106, 100],
      [106, 106],
      [102, 106],
      [102, 103.4],
    ];
    const enemy = playerAt(2, 106, 103, 0); // block (103..109)×(100..106)
    const state = stateWith(player, enemy);
    step(state, {}, TICK_DT_SEC);
    const p = state.players[0];
    const e = state.players[1];
    if (!p || !e) throw new Error('players vanished');
    // Enemy is untouched; own gain excludes the overlap.
    expect(territoryArea(e.territory)).toBeCloseTo(36, 6);
    expect(pointInTerritory(105, 103, p.territory)).toBe(false);
  });
});

describe('area invariants under random play (spec §9.2, fast-check)', () => {
  const turnArb = fc.constantFrom<-1 | 0 | 1>(-1, 0, 1);

  it('areas stay monotone, disjoint, and sum + neutral = 100 %', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 3 }), turn: turnArb }), {
          minLength: 50,
          maxLength: 200,
        }),
        (seed, intents) => {
          // Small arena → walls force returns → loops actually close.
          const arena = 30;
          const state = createSimState(seed, arena);
          step(state, { joins: [1, 2, 3] }, TICK_DT_SEC);
          const lastArea = new Map<number, number>(
            state.players.map((p) => [p.id, territoryArea(p.territory)]),
          );
          for (const intent of intents) {
            step(state, { turns: [intent] }, TICK_DT_SEC);
            let total = 0;
            for (const p of state.players) {
              const area = territoryArea(p.territory);
              // Never negative, never shrinking (nothing takes land yet).
              expect(area).toBeGreaterThanOrEqual((lastArea.get(p.id) ?? 0) - 1e-6);
              lastArea.set(p.id, area);
              total += area;
            }
            // All players + neutral = the whole arena, neutral never negative.
            expect(total).toBeLessThanOrEqual(arena * arena + 1e-6);
          }
          // Pairwise disjoint at the end: no overlap ever created.
          for (let i = 0; i < state.players.length; i++) {
            for (let j = i + 1; j < state.players.length; j++) {
              const a = state.players[i]?.territory ?? [];
              const b = state.players[j]?.territory ?? [];
              expect(territoryArea(intersection(a, b) as Territory)).toBeLessThanOrEqual(1e-6);
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('solo fills never create a hole — every poly is a single outer ring', () => {
    // Holes only ever come from carving foreign land (annulus capture);
    // without enemies, "Fill erzeugt nie Loch" holds literally (spec §9.2).
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(turnArb, { minLength: 100, maxLength: 250 }),
        (seed, turns) => {
          const state = createSimState(seed, 25);
          step(state, { joins: [1] }, TICK_DT_SEC);
          for (const turn of turns) {
            step(state, { turns: [{ id: 1, turn }] }, TICK_DT_SEC);
            for (const poly of state.players[0]?.territory ?? []) {
              expect(poly).toHaveLength(1);
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it('every fill event leaves the filler inside its territory with an empty trail', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(turnArb, { minLength: 100, maxLength: 300 }),
        (seed, turns) => {
          const state = createSimState(seed, 25);
          step(state, { joins: [1] }, TICK_DT_SEC);
          for (const turn of turns) {
            const events = step(state, { turns: [{ id: 1, turn }] }, TICK_DT_SEC);
            const p = state.players[0];
            if (!p) throw new Error('player vanished');
            if (events.fills.includes(1)) {
              expect(p.trail).toHaveLength(0);
              expect(pointInTerritory(p.x, p.y, p.territory)).toBe(true);
            }
            // Trail and containment agree at all times: outside ⇔ trail exists.
            expect(p.trail.length > 0).toBe(!pointInTerritory(p.x, p.y, p.territory));
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
