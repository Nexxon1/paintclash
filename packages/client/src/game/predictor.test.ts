import { TICK_DT_SEC } from '@paintclash/shared';
import type { SnapshotPlayer } from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { Predictor } from './predictor.js';

const ARENA = 200;

function serverSelf(overrides: Partial<SnapshotPlayer> = {}): SnapshotPlayer {
  return { id: 1, x: 100, y: 100, heading: 0, turn: 0, blockCx: 100, blockCy: 100, ...overrides };
}

describe('prediction (client runs sim-core locally, spec §6.1)', () => {
  it('advances the own head immediately on local input', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    expect(predictor.current()?.x).toBeCloseTo(100.45, 10);
  });

  it('turns locally exactly like the server will (same sim-core math)', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 1, TICK_DT_SEC);
    // 320°/s × 50 ms = 16°.
    expect(predictor.current()?.heading).toBeCloseTo((16 * Math.PI) / 180, 10);
  });
});

describe('reconciliation (server corrects, client replays, spec §6.1)', () => {
  it('replays unacked inputs on top of the authoritative state', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    predictor.applyLocalInput(2, 0, TICK_DT_SEC);
    predictor.applyLocalInput(3, 0, TICK_DT_SEC);
    // Server has processed seq 1 only: its state is one tick ahead of spawn.
    predictor.reconcile(serverSelf({ x: 100.45 }), 1, TICK_DT_SEC);
    // Replaying seq 2+3 lands the prediction exactly where it already was.
    expect(predictor.current()?.x).toBeCloseTo(100.45 + 2 * 0.45, 5);
  });

  it('drops acked inputs so they are never applied twice', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    predictor.reconcile(serverSelf({ x: 100.45 }), 1, TICK_DT_SEC);
    predictor.reconcile(serverSelf({ x: 100.45 }), 1, TICK_DT_SEC);
    expect(predictor.current()?.x).toBeCloseTo(100.45, 5);
  });

  it('smooths a server correction instead of snapping (weiches Nachziehen)', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    // Server disagrees: it saw the head 2 WU further up.
    predictor.reconcile(serverSelf({ x: 100.45, y: 102 }), 1, TICK_DT_SEC);
    const displayed = predictor.sample(1);
    if (!displayed) throw new Error('nothing to sample');
    // The displayed position starts near the old prediction …
    expect(displayed.y).toBeLessThan(102);
    // … and converges onto the corrected one within a second of ticks.
    for (let i = 0; i < 20; i++) predictor.decayError();
    const settled = predictor.sample(1);
    expect(settled?.y).toBeCloseTo(102, 1);
  });

  it('renders between the previous and current predicted tick (render interpolation)', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    predictor.applyLocalInput(2, 0, TICK_DT_SEC);
    const halfway = predictor.sample(0.5);
    const full = predictor.sample(1);
    if (!halfway || !full) throw new Error('nothing to sample');
    expect(full.x).toBeGreaterThan(halfway.x);
    expect(halfway.x).toBeCloseTo(full.x - 0.225, 5);
  });

  it('interpolates the heading between ticks too (render interpolation, §4.3)', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 1, TICK_DT_SEC);
    const turnPerTick = (16 * Math.PI) / 180;
    expect(predictor.sample(0)?.heading).toBeCloseTo(0, 10);
    expect(predictor.sample(0.5)?.heading).toBeCloseTo(turnPerTick / 2, 10);
    expect(predictor.sample(1)?.heading).toBeCloseTo(turnPerTick, 10);
  });

  it('returns null before the first snapshot', () => {
    const predictor = new Predictor(ARENA);
    expect(predictor.current()).toBeNull();
    expect(predictor.sample(0.5)).toBeNull();
  });
});
