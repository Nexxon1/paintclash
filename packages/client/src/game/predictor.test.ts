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

  it('adopts the authoritative state when the ack runs AHEAD of every sent seq', () => {
    // Tick-mapped acks (ticket 17) count processed ticks — during a client
    // stall they overtake the client's own seq counter. Nothing replays; the
    // server state is simply the truth.
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 1, TICK_DT_SEC);
    predictor.applyLocalInput(2, 1, TICK_DT_SEC);
    predictor.reconcile(serverSelf({ x: 120, y: 80 }), 30, TICK_DT_SEC);
    expect(predictor.current()?.x).toBeCloseTo(120, 5);
    expect(predictor.current()?.y).toBeCloseTo(80, 5);
  });

  it('survives an ack that rebases BACKWARDS after a server-side resync', () => {
    // A tick-offset re-anchor rebases the ack onto the client's (older)
    // timeline once. The pending filter is stateless — replay just resumes
    // from the new ack, and the pose stays finite and continuous.
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    for (let seq = 1; seq <= 8; seq++) predictor.applyLocalInput(seq, 0, TICK_DT_SEC);
    predictor.reconcile(serverSelf({ x: 103.15 }), 7, TICK_DT_SEC); // normal ack
    predictor.reconcile(serverSelf({ x: 102.25 }), 5, TICK_DT_SEC); // rebased back
    // Seqs 6–7 were already pruned by the earlier ack and stay gone — only
    // seq 8 replays; the gap is a one-time divergence the glide absorbs.
    expect(predictor.current()?.x).toBeCloseTo(102.25 + 0.45, 5);
    const displayed = predictor.sample(1);
    expect(Number.isFinite(displayed?.x)).toBe(true);
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

  it('a mid-tick server correction never jumps the rendered pose — heading included', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    const before = predictor.sample(0.4);
    if (!before) throw new Error('nothing to sample');
    // Server disagrees by 2 WU sideways and ~30°.
    predictor.reconcile(serverSelf({ x: 100.45, y: 102, heading: 0.5 }), 1, TICK_DT_SEC);
    const after = predictor.sample(0.4);
    if (!after) throw new Error('nothing to sample');
    // Continuity at the swap instant — the correction only flows in later
    // via the decaying error offsets.
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.heading).toBeCloseTo(before.heading, 6);
  });

  it('a heading correction glides in over frames instead of whipping around', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    // Server says we are looking 90° elsewhere (post-stall situation).
    predictor.reconcile(serverSelf({ x: 100.45, heading: Math.PI / 2 }), 1, TICK_DT_SEC);
    // Right at the swap the rendered heading is still the old one …
    expect(predictor.sample(1)?.heading).toBeCloseTo(0, 2);
    // … and converges to the server heading via frame-based decay.
    for (let i = 0; i < 50; i++) predictor.decayError(16.7);
    expect(predictor.sample(1)?.heading).toBeCloseTo(Math.PI / 2, 1);
  });

  it('teleport-grade divergence jumps the excess and glides only the cap', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    predictor.reconcile(serverSelf({ x: 150, y: 150 }), 1, TICK_DT_SEC);
    const pose = predictor.sample(1);
    if (!pose) throw new Error('nothing to sample');
    // Rendered pose lands within the 8-WU glide cap of the server state —
    // the rest of the ~70 WU divergence jumped immediately.
    expect(Math.hypot(pose.x - 150, pose.y - 150)).toBeLessThanOrEqual(8.001);
    expect(Math.hypot(pose.x - 150, pose.y - 150)).toBeGreaterThan(7);
    // And converges onto the server state from there (speed-capped glide:
    // 8 WU at ≤ 5 WU/s take ~2 s of frames).
    for (let i = 0; i < 80; i++) predictor.decayError(50);
    const settled = predictor.sample(1);
    if (!settled) throw new Error('nothing to sample');
    expect(Math.hypot(settled.x - 150, settled.y - 150)).toBeLessThan(0.2);
  });

  it('the glide never exceeds +5 WU/s — no fast-forward feel', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    // 4 WU behind the server (post-hiccup situation).
    predictor.reconcile(serverSelf({ x: 100.45, y: 104 }), 1, TICK_DT_SEC);
    let previous = predictor.sample(1);
    for (let i = 0; i < 10; i++) {
      predictor.decayError(50);
      const current = predictor.sample(1);
      if (!previous || !current) throw new Error('nothing to sample');
      // Per 50-ms frame the glide contributes at most 0.25 WU.
      expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThanOrEqual(
        0.2501,
      );
      previous = current;
    }
  });

  it('error decay scales with real frame time', () => {
    const predictor = new Predictor(ARENA);
    predictor.reconcile(serverSelf(), 0, TICK_DT_SEC);
    predictor.applyLocalInput(1, 0, TICK_DT_SEC);
    predictor.reconcile(serverSelf({ x: 100.45, y: 104 }), 1, TICK_DT_SEC);
    const start = predictor.sample(1);
    // Three 16.7-ms frames ≈ one 50-ms frame worth of decay.
    const p2 = new Predictor(ARENA);
    p2.reconcile(serverSelf(), 0, TICK_DT_SEC);
    p2.applyLocalInput(1, 0, TICK_DT_SEC);
    p2.reconcile(serverSelf({ x: 100.45, y: 104 }), 1, TICK_DT_SEC);
    for (let i = 0; i < 3; i++) predictor.decayError(16.7);
    p2.decayError(50);
    expect(predictor.sample(1)?.y).toBeCloseTo(p2.sample(1)?.y ?? NaN, 2);
    // A mega-frame after a stall is capped — it cannot swallow the glide.
    const p3 = new Predictor(ARENA);
    p3.reconcile(serverSelf(), 0, TICK_DT_SEC);
    p3.applyLocalInput(1, 0, TICK_DT_SEC);
    p3.reconcile(serverSelf({ x: 100.45, y: 104 }), 1, TICK_DT_SEC);
    p3.decayError(1500);
    const afterMega = p3.sample(1);
    if (!afterMega || !start) throw new Error('nothing to sample');
    expect(Math.abs(afterMega.y - 104)).toBeGreaterThan(1); // still gliding
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
