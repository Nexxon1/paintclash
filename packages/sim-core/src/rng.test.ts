import { describe, expect, it } from 'vitest';

import { nextRandom, seedRng } from './rng.js';

// The RNG is the only randomness sim-core ever sees — injected, seeded,
// advanced purely through state (ADR-0003: no Math.random, no clock).
describe('seeded RNG', () => {
  it('produces the identical sequence for the identical seed', () => {
    let a = seedRng(42);
    let b = seedRng(42);
    for (let i = 0; i < 100; i++) {
      const ra = nextRandom(a);
      const rb = nextRandom(b);
      expect(ra.value).toBe(rb.value);
      a = ra.state;
      b = rb.state;
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = nextRandom(seedRng(1));
    const b = nextRandom(seedRng(2));
    expect(a.value).not.toBe(b.value);
  });

  it('yields values in [0, 1) that actually vary', () => {
    let state = seedRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const r = nextRandom(state);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(1);
      seen.add(r.value);
      state = r.state;
    }
    expect(seen.size).toBeGreaterThan(990);
  });

  it('never returns the state it was given (pure advance, no mutation)', () => {
    const s0 = seedRng(9);
    const r = nextRandom(s0);
    expect(r.state).not.toBe(s0);
  });
});
