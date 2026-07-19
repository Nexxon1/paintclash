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
    for (let i = 0; i < INPUT_FLUSH_TICKS; i++) session.simTick(1);
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    const decoded = decodeClientMessage(frame);
    if (decoded?.type !== 'input') throw new Error('expected an input batch');
    expect(decoded.inputs).toHaveLength(INPUT_FLUSH_TICKS);
    expect(decoded.inputs[0]?.seq).toBe(1);
    expect(decoded.inputs.every((i) => i.turn === 1)).toBe(true);
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

  it('ignores malformed server frames', () => {
    const { session } = harness();
    joined(session);
    expect(() => {
      session.receive(new Uint8Array([0xba, 0xad, 0xf0, 0x0d]));
    }).not.toThrow();
    expect(session.ready()).toBe(true);
  });
});
