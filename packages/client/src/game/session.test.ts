import { BALANCE } from '@paintclash/shared';
import {
  decodeClientMessage,
  encodeSnapshot,
  encodeWelcome,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { ClientSession, INPUT_FLUSH_TICKS } from './session.js';

function harness(): { session: ClientSession; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const session = new ClientSession((frame) => sent.push(frame), 'tester');
  return { session, sent };
}

function selfPlayer(overrides: Partial<SnapshotPlayer> = {}): SnapshotPlayer {
  return { id: 1, x: 100, y: 100, heading: 0, turn: 0, blockCx: 100, blockCy: 100, ...overrides };
}

function joined(session: ClientSession): void {
  session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
  session.receive(encodeSnapshot(1, 0, [selfPlayer()]));
}

describe('handshake', () => {
  it('join() sends the join frame with the name', () => {
    const { session, sent } = harness();
    session.join();
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    expect(decodeClientMessage(frame)).toMatchObject({ type: 'join', name: 'tester' });
  });

  it('becomes ready once welcome + first snapshot arrived', () => {
    const { session } = harness();
    expect(session.ready()).toBe(false);
    joined(session);
    expect(session.ready()).toBe(true);
    expect(session.playerId).toBe(1);
  });
});

describe('sim ticks (input → prediction → batched send)', () => {
  it('flushes one batched input frame every INPUT_FLUSH_TICKS ticks', () => {
    const { session, sent } = harness();
    joined(session);
    sent.length = 0;
    // Steering straight (no direction change) exercises the pure cadence.
    for (let i = 0; i < INPUT_FLUSH_TICKS; i++) session.simTick(0);
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    const decoded = decodeClientMessage(frame);
    if (decoded?.type !== 'input') throw new Error('expected an input batch');
    expect(decoded.inputs).toHaveLength(INPUT_FLUSH_TICKS);
    expect(decoded.inputs[0]?.seq).toBe(1);
    expect(decoded.inputs.every((i) => i.turn === 0)).toBe(true);
  });

  it('flushes immediately when the steer direction changes (turn-onset latency)', () => {
    const { session, sent } = harness();
    joined(session);
    sent.length = 0;
    session.simTick(1); // direction change 0 → 1: flush now, not at tick 3
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    const decoded = decodeClientMessage(frame);
    if (decoded?.type !== 'input') throw new Error('expected an input batch');
    expect(decoded.inputs).toEqual([{ seq: 1, turn: 1 }]);
    // Holding the same direction returns to the batch cadence.
    session.simTick(1);
    session.simTick(1);
    expect(sent).toHaveLength(1);
    session.simTick(1);
    expect(sent).toHaveLength(2);
  });

  it('predicts the own head forward on every tick', () => {
    const { session } = harness();
    joined(session);
    session.simTick(0);
    const pose = session.renderSample(1);
    expect(pose.self?.x).toBeCloseTo(100.45, 5);
  });

  it('does nothing before the session is ready', () => {
    const { session, sent } = harness();
    session.simTick(1);
    expect(sent).toHaveLength(0);
    expect(session.renderSample(1).self).toBeNull();
  });
});

describe('snapshots feed reconciliation + interpolation', () => {
  it('reconciles the own player from the snapshot ack', () => {
    const { session } = harness();
    joined(session);
    session.simTick(0);
    session.simTick(0);
    // Server processed seq 1 → its self is one tick ahead of spawn.
    session.receive(encodeSnapshot(2, 1, [selfPlayer({ x: 100.45 })]));
    const pose = session.renderSample(1);
    // seq 2 replays on top: exactly two ticks from spawn (plus f32 wobble).
    expect(pose.self?.x).toBeCloseTo(100.9, 3);
  });

  it('exposes the own start block for rendering', () => {
    const { session } = harness();
    expect(session.renderSample(1).selfBlock).toBeNull();
    joined(session);
    expect(session.renderSample(1).selfBlock).toEqual({ cx: 100, cy: 100 });
  });

  it('exposes other players at an interpolation delay', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeSnapshot(2, 0, [selfPlayer(), selfPlayer({ id: 2, x: 50 })]));
    session.receive(encodeSnapshot(3, 0, [selfPlayer(), selfPlayer({ id: 2, x: 51 })]));
    const pose = session.renderSample(1);
    const other = pose.others.find((o) => o.id === 2);
    expect(other).toBeDefined();
    expect(other?.x).toBeLessThanOrEqual(51);
    // Never the own player among the others.
    expect(pose.others.some((o) => o.id === 1)).toBe(false);
  });

  it('keeps enemies moving on the local clock even when no snapshot arrives', () => {
    // The enemy timeline must NOT be driven by snapshot arrival — network
    // jitter would become visible time jumps. It advances with simTick.
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    session.receive(encodeSnapshot(1, 0, [selfPlayer(), selfPlayer({ id: 2, x: 49 })]));
    session.receive(encodeSnapshot(2, 0, [selfPlayer(), selfPlayer({ id: 2, x: 50 })]));
    session.receive(encodeSnapshot(3, 0, [selfPlayer(), selfPlayer({ id: 2, x: 51 })]));
    const positions: number[] = [];
    for (let i = 0; i < 4; i++) {
      const other = session.renderSample(0).others.find((o) => o.id === 2);
      if (other) positions.push(other.x);
      session.simTick(0); // local clock advances, no new snapshots
    }
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      if (prev === undefined || curr === undefined) throw new Error('missing sample');
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
    // It really moved somewhere within the buffered range.
    expect(positions[positions.length - 1]).toBeGreaterThan(positions[0] ?? Infinity);
    expect(positions[positions.length - 1]).toBeLessThanOrEqual(51);
  });

  it('never teleports enemies on a hitch-sized clock jump — catches up rate-limited', () => {
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    // Enemy walks 1 WU per tick along x.
    for (let t = 1; t <= 3; t++) {
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x: 40 + t })]));
    }
    const before = session.renderSample(0).others.find((o) => o.id === 2);
    // Hitch: the next snapshots are 15 ticks ahead (≤ the snap threshold).
    for (let t = 18; t <= 20; t++) {
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x: 40 + t })]));
    }
    const after = session.renderSample(0, 50).others.find((o) => o.id === 2);
    if (!before || !after) throw new Error('enemy missing');
    // One 50-ms frame may advance the enemy timeline at most 2 ticks (2 WU
    // here) — never the whole 15-tick jump at once.
    expect(after.x - before.x).toBeLessThanOrEqual(2.001);
    // And it does keep catching up over subsequent frames.
    let previous = after.x;
    for (let i = 0; i < 20; i++) {
      const next = session.renderSample(0, 50).others.find((o) => o.id === 2);
      if (!next) throw new Error('enemy vanished');
      expect(next.x - previous).toBeLessThanOrEqual(2.001);
      previous = next.x;
    }
    expect(previous).toBeGreaterThan(54); // arrived near the new timeline
  });

  it('a catch-up burst of own ticks glides instead of leaping on screen', () => {
    const { session } = harness();
    joined(session);
    session.simTick(0);
    const before = session.renderSample(1, 0);
    // Post-stall: 10 ticks in one frame, key held (worst case for heading).
    session.advance(1, 10);
    const after = session.renderSample(1, 0);
    if (!before.self || !after.self) throw new Error('missing self');
    // Rendered pose stays continuous at the burst instant …
    expect(Math.hypot(after.self.x - before.self.x, after.self.y - before.self.y)).toBeLessThan(
      0.1,
    );
    // … although the underlying prediction advanced 10 turning ticks
    // (the turn arc shows up on the y axis) — the glide brings it in.
    let sampled = after;
    for (let i = 0; i < 30; i++) {
      session.frame(50);
      sampled = session.renderSample(1, 50);
    }
    expect(Math.abs((sampled.self?.y ?? 0) - before.self.y)).toBeGreaterThan(0.5);
  });

  it('adapts the interpolation delay when snapshot delivery starves the clock', () => {
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    const feed = (t: number): void => {
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x: t })]));
    };
    // Smooth phase: snapshots and local ticks advance in lockstep.
    for (let t = 1; t <= 10; t++) {
      feed(t);
      session.simTick(0);
      session.renderSample(0, 50);
    }
    const newestBefore = 10;
    const renderedBefore = session.renderSample(0, 50).others.find((o) => o.id === 2)?.x ?? NaN;
    const gapBefore = newestBefore - renderedBefore;
    // Starvation: the local clock keeps running, snapshots stop (burst gap).
    for (let i = 0; i < 8; i++) {
      session.simTick(0);
      session.renderSample(0, 50);
    }
    // Delivery resumes smoothly.
    for (let t = 11; t <= 60; t++) {
      feed(t);
      session.simTick(0);
      session.renderSample(0, 50);
    }
    const renderedAfter = session.renderSample(0, 50).others.find((o) => o.id === 2)?.x ?? NaN;
    const gapAfter = 60 - renderedAfter;
    // The delay adapted upward: more headroom against the next burst gap.
    expect(gapAfter).toBeGreaterThan(gapBefore + 1);
  });

  it('ignores malformed server frames', () => {
    const { session } = harness();
    joined(session);
    expect(() => {
      session.receive(new Uint8Array([0xba, 0xad, 0xf0, 0x0d]));
    }).not.toThrow();
    expect(session.ready()).toBe(true);
  });
});
