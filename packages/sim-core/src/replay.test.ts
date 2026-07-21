import { TICK_DT_SEC } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  GOLDEN_END_HASH,
  GOLDEN_SEED,
  GOLDEN_TICKS,
  goldenScript,
} from './fixtures/golden-replay.js';
import { territoryArea } from './geometry.js';
import { cloneSimState, createSimState, hashSimState, type SimState } from './state.js';
import { step, type TickInputs } from './step.js';

function runScript(seed: number, script: ReadonlyMap<number, TickInputs>, ticks: number): SimState {
  const state = createSimState(seed);
  for (let t = 0; t < ticks; t++) {
    step(state, script.get(t) ?? {}, TICK_DT_SEC);
  }
  return state;
}

// Replay determinism is first-class (spec §9.2, ADR-0003): same inputs + same
// seed ⇒ bit-identical state hash. Prediction/reconciliation stands on this.
describe('replay determinism', () => {
  it('same seed + same input log ⇒ bit-identical hash after N ticks', () => {
    const a = runScript(GOLDEN_SEED, goldenScript(), GOLDEN_TICKS);
    const b = runScript(GOLDEN_SEED, goldenScript(), GOLDEN_TICKS);
    expect(hashSimState(a)).toBe(hashSimState(b));
  });

  it('a mid-run clone replayed with the same inputs stays bit-identical', () => {
    const script = goldenScript();
    const original = runScript(GOLDEN_SEED, script, 200);
    const clone = cloneSimState(original);
    for (let t = 200; t < GOLDEN_TICKS; t++) {
      const inputs = script.get(t) ?? {};
      step(original, inputs, TICK_DT_SEC);
      step(clone, inputs, TICK_DT_SEC);
    }
    expect(hashSimState(clone)).toBe(hashSimState(original));
  });

  it('a single diverging intent changes the hash', () => {
    const diverged = goldenScript();
    diverged.set(310, { turns: [{ id: 4, turn: -1 }] });
    const a = runScript(GOLDEN_SEED, goldenScript(), GOLDEN_TICKS);
    const b = runScript(GOLDEN_SEED, diverged, GOLDEN_TICKS);
    expect(hashSimState(a)).not.toBe(hashSimState(b));
  });

  it('a different seed changes the hash (spawns are seed-driven)', () => {
    const a = runScript(1, goldenScript(), GOLDEN_TICKS);
    const b = runScript(2, goldenScript(), GOLDEN_TICKS);
    expect(hashSimState(a)).not.toBe(hashSimState(b));
  });

  it('matches the checked-in golden end hash', () => {
    const end = runScript(GOLDEN_SEED, goldenScript(), GOLDEN_TICKS);
    expect(hashSimState(end)).toBe(GOLDEN_END_HASH);
  });

  it('the golden replay provably crosses the fill path (ticket 04)', () => {
    const state = createSimState(GOLDEN_SEED);
    const script = goldenScript();
    let fills = 0;
    for (let t = 0; t < GOLDEN_TICKS; t++) {
      fills += step(state, script.get(t) ?? {}, TICK_DT_SEC).fills.length;
    }
    expect(fills).toBeGreaterThanOrEqual(1);
    // Player 1's out-and-back maneuver captured real area beyond its block.
    const p1 = state.players.find((p) => p.id === 1);
    expect(territoryArea(p1?.territory ?? [])).toBeGreaterThan(36);
  });
});

describe('properties (fast-check)', () => {
  const turnArb = fc.constantFrom<-1 | 0 | 1>(-1, 0, 1);

  it('players never leave the arena, whatever they steer', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(turnArb, { minLength: 1, maxLength: 300 }),
        (seed, turns) => {
          const state = createSimState(seed);
          step(state, { joins: [1] }, TICK_DT_SEC);
          for (const turn of turns) {
            step(state, { turns: [{ id: 1, turn }] }, TICK_DT_SEC);
            const p = state.players[0];
            if (!p) throw new Error('player vanished');
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(state.arenaSizeWU);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(state.arenaSizeWU);
            expect(Number.isFinite(p.heading)).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('replaying any random script reproduces the hash', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 5 }), turn: turnArb }), {
          maxLength: 200,
        }),
        (seed, intents) => {
          const run = (): string => {
            const state = createSimState(seed);
            step(state, { joins: [1, 2, 3, 4, 5] }, TICK_DT_SEC);
            for (const intent of intents) {
              step(state, { turns: [intent] }, TICK_DT_SEC);
            }
            return hashSimState(state);
          };
          expect(run()).toBe(run());
        },
      ),
      { numRuns: 25 },
    );
  });
});
