import { TICK_DT_SEC } from '@paintclash/shared';
import {
  decodeClientMessage,
  encodeSnapshot,
  encodeWelcome,
  MAX_INPUT_BATCH,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { SimClient } from './index.js';

function harness(name = 'headless'): { client: SimClient; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const client = new SimClient((frame) => sent.push(frame), name);
  return { client, sent };
}

function snapshotPlayer(overrides: Partial<SnapshotPlayer> = {}): SnapshotPlayer {
  return { id: 1, x: 100, y: 100, heading: 0, turn: 0, blockCx: 100, blockCy: 100, ...overrides };
}

describe('join handshake', () => {
  it('sends a decodable join frame with the name', () => {
    const { client, sent } = harness('Ada');
    client.join();
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('no frame sent');
    expect(decodeClientMessage(frame)).toMatchObject({ type: 'join', name: 'Ada' });
  });

  it('adopts playerId + arena size from the welcome', () => {
    const { client } = harness();
    client.receive(encodeWelcome(7, 200));
    expect(client.playerId).toBe(7);
    expect(client.arenaSizeWU).toBe(200);
  });
});

describe('snapshots', () => {
  it('tracks the latest snapshot and exposes the own player', () => {
    const { client } = harness();
    client.receive(encodeWelcome(1, 200));
    client.receive(encodeSnapshot(5, 0, [snapshotPlayer(), snapshotPlayer({ id: 2, x: 50 })]));
    expect(client.snapshot?.tick).toBe(5);
    expect(client.self()?.id).toBe(1);
    expect(client.self()?.x).toBe(100);
  });

  it('ignores malformed frames without dying', () => {
    const { client } = harness();
    client.receive(new Uint8Array([0xff, 0x00]));
    expect(client.snapshot).toBeNull();
  });

  it('ignores stale snapshots that arrive out of order', () => {
    const { client } = harness();
    client.receive(encodeWelcome(1, 200));
    client.receive(encodeSnapshot(9, 0, [snapshotPlayer({ x: 110 })]));
    client.receive(encodeSnapshot(5, 0, [snapshotPlayer({ x: 90 })]));
    expect(client.snapshot?.tick).toBe(9);
    expect(client.self()?.x).toBe(110);
  });
});

describe('steer intents', () => {
  it('batches queued intents into one frame with monotonic seq numbers', () => {
    const { client, sent } = harness();
    client.receive(encodeWelcome(1, 200));
    client.queueTurn(1);
    client.queueTurn(0);
    client.queueTurn(-1);
    client.flush();
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('no frame sent');
    const decoded = decodeClientMessage(frame);
    if (decoded?.type !== 'input') throw new Error('expected an input frame');
    expect(decoded.inputs.map((i) => i.turn)).toEqual([1, 0, -1]);
    const seqs = decoded.inputs.map((i) => i.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // Seqs start at 1: the server acks 0 for "nothing processed", and only
    // seq > ack is fresh — a seq-0 first intent would be silently dropped.
    expect(seqs[0]).toBe(1);
  });

  it('flushing with nothing queued sends nothing', () => {
    const { client, sent } = harness();
    client.flush();
    expect(sent).toHaveLength(0);
  });

  it('splits overlong queues into legal batches', () => {
    const { client, sent } = harness();
    for (let i = 0; i < MAX_INPUT_BATCH + 3; i++) client.queueTurn(1);
    client.flush();
    expect(sent).toHaveLength(2);
    for (const frame of sent) {
      expect(decodeClientMessage(frame)).not.toBeNull();
    }
  });
});

describe('robustness guards', () => {
  it('accepts frames handed over as ArrayBuffer (WebSocket delivery)', () => {
    const { client } = harness();
    const welcome = encodeWelcome(3, 150);
    const buffer = new ArrayBuffer(welcome.byteLength);
    new Uint8Array(buffer).set(welcome);
    client.receive(buffer);
    expect(client.playerId).toBe(3);
  });

  it('self() is null before welcome or when missing from the snapshot', () => {
    const { client } = harness();
    expect(client.self()).toBeNull();
    client.receive(encodeWelcome(1, 200));
    expect(client.self()).toBeNull();
    client.receive(encodeSnapshot(1, 0, [snapshotPlayer({ id: 9 })]));
    expect(client.self()).toBeNull();
    expect(client.predictedSelf()).toBeNull();
  });

  it('predictTick before any snapshot is a no-op', () => {
    const { client } = harness();
    expect(() => {
      client.predictTick(0.05);
    }).not.toThrow();
    expect(client.predictedSelf()).toBeNull();
  });
});

describe('prediction (drives sim-core locally)', () => {
  it('predicts own movement forward from the last snapshot', () => {
    const { client } = harness();
    client.receive(encodeWelcome(1, 200));
    client.receive(encodeSnapshot(1, 0, [snapshotPlayer()]));
    client.queueTurn(0);
    client.predictTick(TICK_DT_SEC);
    const predicted = client.predictedSelf();
    if (!predicted) throw new Error('no predicted self');
    // heading 0 → one tick straight ahead = +0.45 WU in x.
    expect(predicted.x).toBeCloseTo(100.45, 5);
    expect(predicted.y).toBeCloseTo(100, 5);
  });

  it('resets its prediction base onto each fresh snapshot', () => {
    const { client } = harness();
    client.receive(encodeWelcome(1, 200));
    client.receive(encodeSnapshot(1, 0, [snapshotPlayer()]));
    client.predictTick(TICK_DT_SEC);
    client.receive(encodeSnapshot(2, 1, [snapshotPlayer({ x: 100.45 })]));
    const predicted = client.predictedSelf();
    expect(predicted?.x).toBeCloseTo(100.45, 5);
  });
});
