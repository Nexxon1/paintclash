import type { Point, Territory, TurnSignal } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  decodeClientMessage,
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  encodeSnapshot,
  encodeTerritory,
  encodeTrail,
  encodeWelcome,
  MAX_CLIENT_FRAME_BYTES,
  MAX_INPUT_BATCH,
  MAX_NAME_BYTES,
  MAX_TRAIL_POINTS,
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
const pointArb = fc.tuple(f32, f32) as fc.Arbitrary<Point>;
const ringArb = fc.array(pointArb, { minLength: 3, maxLength: 12 });
const territoryArb: fc.Arbitrary<Territory> = fc.array(
  fc.array(ringArb, { minLength: 1, maxLength: 3 }),
  { maxLength: 4 },
);

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

  it('territory', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.constantFrom<'sync' | 'fill'>('sync', 'fill'),
        territoryArb,
        (playerId, reason, territory) => {
          const decoded = decodeServerMessage(encodeTerritory(playerId, reason, territory));
          expect(decoded).toEqual({ type: 'territory', playerId, reason, territory });
        },
      ),
    );
  });

  it('trail', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff }),
        fc.array(pointArb, { maxLength: 200 }),
        (playerId, points) => {
          const decoded = decodeServerMessage(encodeTrail(playerId, points));
          expect(decoded).toEqual({ type: 'trail', playerId, points });
        },
      ),
    );
  });
});

describe('golden bytes (wire format pinned, spec §9.1)', () => {
  it('join "Ada"', () => {
    expect(Array.from(encodeJoin('Ada'))).toEqual([0x01, 0x02, 0x03, 0x41, 0x64, 0x61]);
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
    const player: SnapshotPlayer = { id: 3, x: 1, y: 2, heading: 0, turn: 1 };
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
    ]);
  });

  it('territory fill, player 3, one triangle', () => {
    const territory: Territory = [
      [
        [
          [1, 2],
          [3, 2],
          [1, 4],
        ],
      ],
    ];
    expect(Array.from(encodeTerritory(3, 'fill', territory))).toEqual([
      0x12, // opcode
      0x03,
      0x00, // playerId
      0x01, // reason fill
      0x01, // poly count
      0x01, // ring count
      0x03,
      0x00, // point count
      0x00,
      0x00,
      0x80,
      0x3f, // 1f
      0x00,
      0x00,
      0x00,
      0x40, // 2f
      0x00,
      0x00,
      0x40,
      0x40, // 3f
      0x00,
      0x00,
      0x00,
      0x40, // 2f
      0x00,
      0x00,
      0x80,
      0x3f, // 1f
      0x00,
      0x00,
      0x80,
      0x40, // 4f
    ]);
  });

  it('trail player 7, two points', () => {
    const points: Point[] = [
      [1, 2],
      [3, 4],
    ];
    expect(Array.from(encodeTrail(7, points))).toEqual([
      0x13, // opcode
      0x07,
      0x00, // playerId
      0x02,
      0x00, // point count
      0x00,
      0x00,
      0x80,
      0x3f, // 1f
      0x00,
      0x00,
      0x00,
      0x40, // 2f
      0x00,
      0x00,
      0x40,
      0x40, // 3f
      0x00,
      0x00,
      0x80,
      0x40, // 4f
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
    const player: SnapshotPlayer = { id: 1, x: 0, y: 0, heading: 0, turn: 0 };
    const bad = new Uint8Array(encodeSnapshot(1, 1, [player]));
    bad[10 + 14] = 9; // player turn byte
    expect(decodeServerMessage(bad)).toBeNull();
  });

  const triangle: Territory = [
    [
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    ],
  ];

  it('rejects malformed territory frames', () => {
    // Cut off before the header ends.
    expect(decodeServerMessage(new Uint8Array([0x12, 0x01, 0x00, 0x00]))).toBeNull();
    const ok = encodeTerritory(1, 'sync', triangle);
    // Truncated mid-ring.
    expect(decodeServerMessage(ok.subarray(0, ok.length - 4))).toBeNull();
    // Trailing garbage.
    expect(decodeServerMessage(new Uint8Array([...ok, 0xff]))).toBeNull();
    // Unknown reason byte.
    const badReason = new Uint8Array(ok);
    badReason[3] = 2;
    expect(decodeServerMessage(badReason)).toBeNull();
    // A poly claiming zero rings.
    const zeroRings = new Uint8Array(ok);
    zeroRings[5] = 0;
    expect(decodeServerMessage(zeroRings)).toBeNull();
    // A ring claiming fewer than 3 points.
    const twoPoints = new Uint8Array(ok);
    twoPoints[6] = 2;
    expect(decodeServerMessage(twoPoints)).toBeNull();
    // A poly count pointing past the end of the frame.
    const morePolys = new Uint8Array(ok);
    morePolys[4] = 2;
    expect(decodeServerMessage(morePolys)).toBeNull();
  });

  it('rejects malformed trail frames', () => {
    expect(decodeServerMessage(new Uint8Array([0x13, 0x01, 0x00, 0x02]))).toBeNull();
    const ok = encodeTrail(1, [
      [0, 0],
      [1, 1],
    ]);
    expect(decodeServerMessage(ok.subarray(0, ok.length - 1))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([...ok, 0xff]))).toBeNull();
  });

  it('an empty trail round-trips (clear semantics)', () => {
    expect(decodeServerMessage(encodeTrail(9, []))).toEqual({
      type: 'trail',
      playerId: 9,
      points: [],
    });
  });

  it('an empty territory round-trips (landless player)', () => {
    expect(decodeServerMessage(encodeTerritory(9, 'sync', []))).toEqual({
      type: 'territory',
      playerId: 9,
      reason: 'sync',
      territory: [],
    });
  });

  it('encodeTerritory refuses geometry beyond the wire counts', () => {
    const hugePolys: Territory = Array.from({ length: 256 }, () => triangle[0] ?? []);
    expect(() => encodeTerritory(1, 'sync', hugePolys)).toThrow(RangeError);
    const hugeRings: Territory = [Array.from({ length: 256 }, () => triangle[0]?.[0] ?? [])];
    expect(() => encodeTerritory(1, 'sync', hugeRings)).toThrow(RangeError);
    const hugeRing: Territory = [[Array.from({ length: 0x10000 }, (): Point => [0, 0])]];
    expect(() => encodeTerritory(1, 'sync', hugeRing)).toThrow(RangeError);
  });

  it('encodeTrail keeps the newest points at the wire cap', () => {
    const points = Array.from({ length: MAX_TRAIL_POINTS + 5 }, (_, i): Point => [i, 0]);
    const decoded = decodeServerMessage(encodeTrail(1, points));
    if (decoded?.type !== 'trail') throw new Error('expected a trail');
    expect(decoded.points).toHaveLength(MAX_TRAIL_POINTS);
    expect(decoded.points[decoded.points.length - 1]?.[0]).toBe(Math.fround(MAX_TRAIL_POINTS + 4));
  });
});
