import type { TurnSignal } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decodeClientMessage,
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  encodeSnapshot,
  encodeWelcome,
  MAX_CLIENT_FRAME_BYTES,
  MAX_INPUT_BATCH,
  MAX_NAME_BYTES,
  PROTOCOL_VERSION,
  type SnapshotPlayer,
} from './index.js';

const turnArb = fc.constantFrom<TurnSignal>(-1, 0, 1);
/** f32-representable coordinates — what the wire actually carries. */
const f32 = fc.float({
  noNaN: true,
  noDefaultInfinity: true,
  min: Math.fround(-1e6),
  max: Math.fround(1e6),
});

describe('round-trip (decode ∘ encode = id, spec §9.1)', () => {
  it('join', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 16 }), (name) => {
        const decoded = decodeClientMessage(encodeJoin(name));
        expect(decoded).toEqual({ type: 'join', version: PROTOCOL_VERSION, name });
      }),
    );
  });

  it('input batch', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ seq: fc.integer({ min: 0, max: 0xffffffff }), turn: turnArb }), {
          minLength: 1,
          maxLength: MAX_INPUT_BATCH,
        }),
        (inputs) => {
          const decoded = decodeClientMessage(encodeInput(inputs));
          expect(decoded).toEqual({ type: 'input', inputs });
        },
      ),
    );
  });

  it('welcome', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.float({
          noNaN: true,
          noDefaultInfinity: true,
          min: Math.fround(10),
          max: Math.fround(10000),
        }),
        (playerId, arenaSizeWU) => {
          const decoded = decodeServerMessage(encodeWelcome(playerId, arenaSizeWU));
          expect(decoded).toEqual({ type: 'welcome', playerId, arenaSizeWU });
        },
      ),
    );
  });

  it('snapshot', () => {
    const playerArb = fc.record({
      id: fc.integer({ min: 0, max: 0xffff }),
      x: f32,
      y: f32,
      heading: fc.float({ noNaN: true, noDefaultInfinity: true, min: 0, max: Math.fround(6.283) }),
      turn: turnArb,
      blockCx: f32,
      blockCy: f32,
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.array(playerArb, { maxLength: 64 }),
        (tick, ackSeq, players) => {
          const decoded = decodeServerMessage(encodeSnapshot(tick, ackSeq, players));
          expect(decoded).toEqual({ type: 'snapshot', tick, ackSeq, players });
        },
      ),
    );
  });
});

describe('golden bytes (wire format pinned, spec §9.1)', () => {
  it('join "Ada"', () => {
    expect(Array.from(encodeJoin('Ada'))).toEqual([0x01, 0x01, 0x03, 0x41, 0x64, 0x61]);
  });

  it('input batch [seq 7 turn -1, seq 8 turn 1]', () => {
    expect(
      Array.from(
        encodeInput([
          { seq: 7, turn: -1 },
          { seq: 8, turn: 1 },
        ]),
      ),
    ).toEqual([0x02, 0x02, 0x07, 0x00, 0x00, 0x00, 0xff, 0x08, 0x00, 0x00, 0x00, 0x01]);
  });

  it('welcome playerId 5, arena 200 WU', () => {
    // f32 little-endian 200 = 0x43480000.
    expect(Array.from(encodeWelcome(5, 200))).toEqual([0x10, 0x05, 0x00, 0x00, 0x00, 0x48, 0x43]);
  });

  it('snapshot tick 1, ack 2, one player', () => {
    const player: SnapshotPlayer = {
      id: 3,
      x: 1,
      y: 2,
      heading: 0,
      turn: 1,
      blockCx: 1,
      blockCy: 2,
    };
    expect(Array.from(encodeSnapshot(1, 2, [player]))).toEqual([
      0x11, // opcode
      0x01,
      0x00,
      0x00,
      0x00, // tick
      0x02,
      0x00,
      0x00,
      0x00, // ackSeq
      0x01, // player count
      0x03,
      0x00, // id
      0x00,
      0x00,
      0x80,
      0x3f, // x = 1f
      0x00,
      0x00,
      0x00,
      0x40, // y = 2f
      0x00,
      0x00,
      0x00,
      0x00, // heading = 0f
      0x01, // turn
      0x00,
      0x00,
      0x80,
      0x3f, // blockCx = 1f
      0x00,
      0x00,
      0x00,
      0x40, // blockCy = 2f
    ]);
  });
});

describe('malformed frames are rejected, never thrown (spec §8.2)', () => {
  it('rejects an unknown opcode', () => {
    expect(decodeClientMessage(new Uint8Array([0x77]))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([0x77]))).toBeNull();
  });

  it('rejects an empty frame', () => {
    expect(decodeClientMessage(new Uint8Array([]))).toBeNull();
  });

  it('rejects a truncated input batch', () => {
    const ok = encodeInput([{ seq: 1, turn: 0 }]);
    expect(decodeClientMessage(ok.subarray(0, ok.length - 1))).toBeNull();
  });

  it('rejects an input batch whose declared count disagrees with its length', () => {
    const frame = new Uint8Array(encodeInput([{ seq: 1, turn: 0 }]));
    frame[1] = 2; // claims two inputs, carries one
    expect(decodeClientMessage(frame)).toBeNull();
  });

  it('rejects an out-of-range turn value', () => {
    const frame = new Uint8Array(encodeInput([{ seq: 1, turn: 0 }]));
    frame[6] = 5; // turn byte
    expect(decodeClientMessage(frame)).toBeNull();
  });

  it('rejects an oversized batch declaration', () => {
    const frame = new Uint8Array(2 + (MAX_INPUT_BATCH + 1) * 5);
    frame[0] = 0x02;
    frame[1] = MAX_INPUT_BATCH + 1;
    expect(decodeClientMessage(frame)).toBeNull();
  });

  it('rejects a join with a foreign protocol version', () => {
    const frame = new Uint8Array(encodeJoin('x'));
    frame[1] = PROTOCOL_VERSION + 1;
    expect(decodeClientMessage(frame)).toBeNull();
  });

  it('rejects a join whose name overflows the byte cap', () => {
    const frame = new Uint8Array([0x01, PROTOCOL_VERSION, MAX_NAME_BYTES + 1]);
    expect(decodeClientMessage(frame)).toBeNull();
  });

  it('rejects a join with trailing garbage', () => {
    const frame = new Uint8Array([...encodeJoin('x'), 0xde, 0xad]);
    expect(decodeClientMessage(frame)).toBeNull();
  });

  it('encodeJoin caps name bytes so every legal frame fits the frame cap', () => {
    const huge = '🦑'.repeat(64);
    const frame = encodeJoin(huge);
    expect(frame.length).toBeLessThanOrEqual(MAX_CLIENT_FRAME_BYTES);
    expect(decodeClientMessage(frame)).not.toBeNull();
  });

  it('a maximal input batch stays within the frame cap', () => {
    const inputs = Array.from(
      { length: MAX_INPUT_BATCH },
      (_, i): { seq: number; turn: TurnSignal } => ({
        seq: i,
        turn: 1,
      }),
    );
    expect(encodeInput(inputs).length).toBeLessThanOrEqual(MAX_CLIENT_FRAME_BYTES);
  });

  it('rejects any client frame above the size cap before parsing (spec §8.3)', () => {
    const oversized = new Uint8Array(MAX_CLIENT_FRAME_BYTES + 1).fill(0x02);
    expect(decodeClientMessage(oversized)).toBeNull();
  });

  it('rejects a client frame cut off before its header ends', () => {
    expect(decodeClientMessage(new Uint8Array([0x01]))).toBeNull(); // join, no version
    expect(decodeClientMessage(new Uint8Array([0x02]))).toBeNull(); // input, no count
  });

  it('encodeInput refuses illegal batch sizes outright', () => {
    expect(() => encodeInput([])).toThrow(RangeError);
    const tooMany = Array.from(
      { length: MAX_INPUT_BATCH + 1 },
      (_, i): { seq: number; turn: TurnSignal } => ({ seq: i, turn: 0 }),
    );
    expect(() => encodeInput(tooMany)).toThrow(RangeError);
  });

  it('rejects malformed server frames too (defensive client, spec §9.1)', () => {
    expect(decodeServerMessage(new Uint8Array([]))).toBeNull();
    // Welcome with the wrong length.
    expect(decodeServerMessage(new Uint8Array([0x10, 0x05, 0x00]))).toBeNull();
    // Snapshot cut off before its header ends.
    expect(decodeServerMessage(new Uint8Array([0x11, 0x01, 0x00]))).toBeNull();
    // Snapshot whose count disagrees with its length.
    const snapshot = new Uint8Array(encodeSnapshot(1, 1, []));
    snapshot[9] = 1;
    expect(decodeServerMessage(snapshot)).toBeNull();
    // Snapshot carrying an out-of-range turn.
    const player: SnapshotPlayer = {
      id: 1,
      x: 0,
      y: 0,
      heading: 0,
      turn: 0,
      blockCx: 0,
      blockCy: 0,
    };
    const bad = new Uint8Array(encodeSnapshot(1, 1, [player]));
    bad[10 + 14] = 9; // player turn byte
    expect(decodeServerMessage(bad)).toBeNull();
  });
});
