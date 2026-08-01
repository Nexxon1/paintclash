import { describe, expect, it } from 'vitest';

import { BALANCE, TICK_DT_MS, TICK_DT_SEC, TICK_HZ, TURN_RADIUS_WU } from './balance.js';
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
    expect(BALANCE.trail.collisionRadiusWU).toBe(0.5);
    // Re-tuned from the §10.4 start value 1 WU² — see balance.ts rationale.
    expect(BALANCE.trail.minFillAreaWU2).toBe(0.01);
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
    expect(Object.isFrozen(BALANCE.bots)).toBe(true);
  });

  it('has only positive, finite magnitudes', () => {
    const groups = [BALANCE.arena, BALANCE.movement, BALANCE.spawn, BALANCE.trail, BALANCE.bots];
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

  it('has no self-cut grace window left to tune (ticket 19)', () => {
    // The self-cut is a line crossing now, not a proximity test with a
    // forgiven path length — so there is no window whose bounds could drift.
    expect(BALANCE.trail).not.toHaveProperty('selfCutGraceWU');
  });

  it('carries the spec §2.7 bot population rule', () => {
    expect(BALANCE.bots.targetPopulation).toBe(8);
    expect(BALANCE.bots.maxBots).toBe(8);
    // A bot may never displace a human: the ceiling cannot exceed the target,
    // or `clamp(target − humans, 0, maxBots)` could keep bots around while
    // humans are still arriving.
    expect(BALANCE.bots.maxBots).toBeLessThanOrEqual(BALANCE.bots.targetPopulation);
  });

  it('keeps the bot pilot inside its geometric window', () => {
    // The return lane must clear the U-turn at the tip, or every excursion
    // would end in a self-cut (see balance.ts rationale).
    expect(BALANCE.bots.laneOffsetWU).toBeGreaterThan(2 * TURN_RADIUS_WU);
    // An excursion has to leave the start block behind to enclose anything.
    expect(BALANCE.bots.excursionWU).toBeGreaterThan(BALANCE.spawn.startBlockWU);
    // Evasion must start before the head-on distance decides the matter.
    expect(BALANCE.bots.evadeRadiusWU).toBeGreaterThan(2 * BALANCE.trail.collisionRadiusWU);
    // ...and a bot must be able to see the threat it is asked to evade.
    expect(BALANCE.bots.sightRadiusWU).toBeGreaterThan(BALANCE.bots.evadeRadiusWU);
    // The trail budget has to cover a full planned excursion (out and back
    // along the offset lane) — otherwise the safety net fires on every run.
    expect(BALANCE.bots.maxTrailWU).toBeGreaterThan(2 * BALANCE.bots.excursionWU);
    // Planning margin and excursion must fit the arena from its centre.
    expect(BALANCE.bots.excursionWU + BALANCE.bots.wallMarginWU).toBeLessThan(
      BALANCE.arena.sizeWU / 2,
    );
  });
});
