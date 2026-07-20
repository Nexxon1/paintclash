import type { SnapshotPlayer } from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { Interpolator } from './interpolator.js';

function player(id: number, overrides: Partial<SnapshotPlayer> = {}): SnapshotPlayer {
  return { id, x: 0, y: 0, heading: 0, turn: 0, blockCx: 0, blockCy: 0, ...overrides };
}

describe('enemy interpolation between snapshots (spec §6.1)', () => {
  it('lerps positions between the two bracketing snapshots', () => {
    const interp = new Interpolator();
    interp.add(10, [player(2, { x: 10, y: 0 })]);
    interp.add(11, [player(2, { x: 12, y: 4 })]);
    const [other] = interp.sample(10.5);
    expect(other?.x).toBeCloseTo(11, 10);
    expect(other?.y).toBeCloseTo(2, 10);
  });

  it('interpolates headings across the 0/2π wrap the short way', () => {
    const interp = new Interpolator();
    interp.add(10, [player(2, { heading: 6.1 })]);
    interp.add(11, [player(2, { heading: 0.2 })]);
    const [other] = interp.sample(10.5);
    // Short way crosses 2π ≈ 6.283: midpoint ≈ 6.2415 (mod 2π).
    expect(other?.heading).toBeCloseTo((6.1 + (0.2 + 2 * Math.PI - 6.1) / 2) % (2 * Math.PI), 5);
  });

  it('excludes the own player id', () => {
    const interp = new Interpolator();
    interp.add(10, [player(1), player(2)]);
    interp.add(11, [player(1), player(2)]);
    const others = interp.sample(10.5, 1);
    expect(others.map((o) => o.id)).toEqual([2]);
  });

  it('shows a newly appeared player at their snapshot position', () => {
    const interp = new Interpolator();
    interp.add(10, [player(2)]);
    interp.add(11, [player(2), player(3, { x: 50 })]);
    const others = interp.sample(10.5);
    expect(others.find((o) => o.id === 3)?.x).toBe(50);
  });

  it('drops players that vanished from the newer snapshot', () => {
    const interp = new Interpolator();
    interp.add(10, [player(2), player(3)]);
    interp.add(11, [player(2)]);
    const others = interp.sample(10.5);
    expect(others.map((o) => o.id)).toEqual([2]);
  });

  it('clamps sampling beyond the buffered range to the edges', () => {
    const interp = new Interpolator();
    interp.add(10, [player(2, { x: 10 })]);
    interp.add(11, [player(2, { x: 12 })]);
    expect(interp.sample(5)[0]?.x).toBe(10);
    expect(interp.sample(99)[0]?.x).toBe(12);
  });

  it('is empty before any snapshot arrived', () => {
    const interp = new Interpolator();
    expect(interp.sample(0)).toEqual([]);
    expect(interp.latestTick()).toBeNull();
  });

  it('keeps a bounded buffer', () => {
    const interp = new Interpolator();
    for (let t = 0; t < 200; t++) interp.add(t, [player(2, { x: t })]);
    expect(interp.latestTick()).toBe(199);
    // Old ticks fell out of the buffer — sampling clamps to what is left.
    expect(interp.sample(0)[0]?.x).toBeGreaterThan(0);
  });
});
