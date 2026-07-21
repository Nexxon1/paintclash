import { describe, expect, it } from 'vitest';

import { BALANCE, TICK_DT_MS, TICK_DT_SEC, TICK_HZ } from './balance.js';
import { LIMITS } from './limits.js';

// Sanity only (spec §9.3): value ranges valid, structure frozen. The values
// themselves are the spec §10 start values — asserted as such so an accidental
// edit is caught, a deliberate re-balance updates both sides.
describe('BALANCE', () => {
  it('carries the spec §10 start values', () => {
    expect(BALANCE.arena.sizeWU).toBe(200);
    expect(BALANCE.movement.speedWuPerSec).toBe(9);
    expect(BALANCE.movement.turnRateDegPerSec).toBe(320);
    expect(BALANCE.spawn.startBlockWU).toBe(6);
    expect(BALANCE.spawn.minDistanceWU).toBe(25);
    expect(BALANCE.trail.widthWU).toBe(1);
    expect(BALANCE.trail.minFillAreaWU2).toBe(1);
  });

  it('ticks at 20 Hz with a fixed 50 ms dt', () => {
    expect(TICK_HZ).toBe(20);
    expect(TICK_DT_MS).toBe(50);
    expect(TICK_DT_SEC).toBeCloseTo(0.05);
  });

  it('is deeply frozen — tuning happens in source, never at runtime', () => {
    expect(Object.isFrozen(BALANCE)).toBe(true);
    expect(Object.isFrozen(BALANCE.arena)).toBe(true);
    expect(Object.isFrozen(BALANCE.movement)).toBe(true);
    expect(Object.isFrozen(BALANCE.spawn)).toBe(true);
    expect(Object.isFrozen(BALANCE.trail)).toBe(true);
  });

  it('has only positive, finite magnitudes', () => {
    const groups = [BALANCE.arena, BALANCE.movement, BALANCE.spawn, BALANCE.trail];
    for (const group of groups) {
      for (const value of Object.values(group)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('has frozen, positive protection limits (spec §8.3, beside BALANCE)', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
    for (const value of Object.values(LIMITS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    // The flood cap must at least absorb one full input batch.
    expect(LIMITS.maxPendingInputs).toBeGreaterThanOrEqual(LIMITS.inputFlushTicks);
    // The drift servo's deadband must exceed one tick, or its ±1 steps
    // would oscillate; the resync gate must sit far outside the band.
    expect(LIMITS.tickMapMaxMarginTicks - LIMITS.tickMapMinMarginTicks).toBeGreaterThan(1);
    expect(LIMITS.tickMapResyncTicks).toBeGreaterThan(LIMITS.tickMapMaxMarginTicks);
  });

  it('keeps the start block + min distance inside the arena', () => {
    expect(BALANCE.spawn.startBlockWU).toBeLessThan(BALANCE.arena.sizeWU);
    expect(BALANCE.spawn.minDistanceWU).toBeLessThan(BALANCE.arena.sizeWU / 2);
  });
});
