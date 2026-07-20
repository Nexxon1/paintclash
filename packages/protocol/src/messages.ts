/**
 * Binary wire format (spec §6.3, ADR-0003) — little-endian, one opcode byte,
 * shared verbatim by client and server. Decoders validate opcode, length and
 * value ranges and return `null` for anything malformed; the server drops
 * such frames at the protocol boundary (spec §8.2) instead of throwing.
 */

import type { TurnSignal } from '@paintclash/shared';

/** Bumped on every incompatible wire change; joins carry it. */
export const PROTOCOL_VERSION = 1;

/** Nickname cap on the wire: 16 code points, ≤ 64 UTF-8 bytes. */
export const MAX_NAME_CHARS = 16;
export const MAX_NAME_BYTES = 64;

/** Inputs per batched frame (spec §6.3 input batching, WS 20:1 budget). */
export const MAX_INPUT_BATCH = 20;

/** Hard size cap checked before parsing any client frame (spec §8.3). */
export const MAX_CLIENT_FRAME_BYTES = 128;

const OP_JOIN = 0x01;
const OP_INPUT = 0x02;
const OP_WELCOME = 0x10;
const OP_SNAPSHOT = 0x11;

const INPUT_ITEM_BYTES = 5; // u32 seq + i8 turn
const SNAPSHOT_PLAYER_BYTES = 23; // u16 id + 3×f32 + i8 turn + 2×f32

export interface InputItem {
  /** Monotonic input sequence number (reconciliation anchor, spec §6.4). */
  seq: number;
  turn: TurnSignal;
}

export interface SnapshotPlayer {
  id: number;
  x: number;
  y: number;
  heading: number;
  turn: TurnSignal;
  blockCx: number;
  blockCy: number;
}

export type ClientMessage =
  { type: 'join'; version: number; name: string } | { type: 'input'; inputs: InputItem[] };

export type ServerMessage =
  | { type: 'welcome'; playerId: number; arenaSizeWU: number }
  | { type: 'snapshot'; tick: number; ackSeq: number; players: SnapshotPlayer[] };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

function isTurnSignal(value: number): value is TurnSignal {
  return value === -1 || value === 0 || value === 1;
}

/** Longest prefix of `name` within both the code-point and byte cap. */
function capName(name: string): string {
  let capped = '';
  let chars = 0;
  let bytes = 0;
  // for…of iterates code points — full nickname policy (visible-character
  // counting, filtering) is ticket 13; the wire only guarantees hard caps.
  for (const cp of name) {
    const cpBytes = textEncoder.encode(cp).length;
    if (chars + 1 > MAX_NAME_CHARS || bytes + cpBytes > MAX_NAME_BYTES) break;
    capped += cp;
    chars += 1;
    bytes += cpBytes;
  }
  return capped;
}

/** Join wish with the display name, capped to the wire limits. */
export function encodeJoin(name: string): Uint8Array {
  const nameBytes = textEncoder.encode(capName(name));
  const frame = new Uint8Array(3 + nameBytes.length);
  frame[0] = OP_JOIN;
  frame[1] = PROTOCOL_VERSION;
  frame[2] = nameBytes.length;
  frame.set(nameBytes, 3);
  return frame;
}

/** Batched steer intents — the only thing a client may say per spec §8.2. */
export function encodeInput(inputs: readonly InputItem[]): Uint8Array {
  if (inputs.length < 1 || inputs.length > MAX_INPUT_BATCH) {
    throw new RangeError(`input batch must hold 1..${String(MAX_INPUT_BATCH)} items`);
  }
  const frame = new Uint8Array(2 + inputs.length * INPUT_ITEM_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = OP_INPUT;
  frame[1] = inputs.length;
  inputs.forEach((input, i) => {
    const offset = 2 + i * INPUT_ITEM_BYTES;
    view.setUint32(offset, input.seq, true);
    view.setInt8(offset + 4, input.turn);
  });
  return frame;
}

export function encodeWelcome(playerId: number, arenaSizeWU: number): Uint8Array {
  const frame = new Uint8Array(7);
  const view = new DataView(frame.buffer);
  frame[0] = OP_WELCOME;
  view.setUint16(1, playerId, true);
  view.setFloat32(3, arenaSizeWU, true);
  return frame;
}

export function encodeSnapshot(
  tick: number,
  ackSeq: number,
  players: readonly SnapshotPlayer[],
): Uint8Array {
  const frame = new Uint8Array(10 + players.length * SNAPSHOT_PLAYER_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = OP_SNAPSHOT;
  view.setUint32(1, tick, true);
  view.setUint32(5, ackSeq, true);
  frame[9] = players.length;
  players.forEach((p, i) => {
    const offset = 10 + i * SNAPSHOT_PLAYER_BYTES;
    view.setUint16(offset, p.id, true);
    view.setFloat32(offset + 2, p.x, true);
    view.setFloat32(offset + 6, p.y, true);
    view.setFloat32(offset + 10, p.heading, true);
    view.setInt8(offset + 14, p.turn);
    view.setFloat32(offset + 15, p.blockCx, true);
    view.setFloat32(offset + 19, p.blockCy, true);
  });
  return frame;
}

/**
 * Decode a frame arriving *from* a client. Returns `null` on anything that
 * is not a perfectly-formed frame — wrong opcode, wrong length, out-of-range
 * values — so the server can drop it without a try/catch.
 */
export function decodeClientMessage(frame: Uint8Array): ClientMessage | null {
  if (frame.length === 0 || frame.length > MAX_CLIENT_FRAME_BYTES) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  switch (frame[0]) {
    case OP_JOIN: {
      if (frame.length < 3) return null;
      const version = view.getUint8(1);
      if (version !== PROTOCOL_VERSION) return null;
      const nameLen = view.getUint8(2);
      if (nameLen > MAX_NAME_BYTES || frame.length !== 3 + nameLen) return null;
      const name = textDecoder.decode(frame.subarray(3, 3 + nameLen));
      // The byte cap alone admits up to 64 ASCII chars from a hand-crafted
      // frame — enforce the code-point cap on decode too (wire invariant).
      if (Array.from(name).length > MAX_NAME_CHARS) return null;
      return { type: 'join', version, name };
    }
    case OP_INPUT: {
      if (frame.length < 2) return null;
      const count = view.getUint8(1);
      if (count < 1 || count > MAX_INPUT_BATCH) return null;
      if (frame.length !== 2 + count * INPUT_ITEM_BYTES) return null;
      const inputs: InputItem[] = [];
      for (let i = 0; i < count; i++) {
        const offset = 2 + i * INPUT_ITEM_BYTES;
        const seq = view.getUint32(offset, true);
        const turn = view.getInt8(offset + 4);
        if (!isTurnSignal(turn)) return null;
        inputs.push({ seq, turn });
      }
      return { type: 'input', inputs };
    }
    default:
      return null;
  }
}

/** Decode a frame arriving *from* the server. Same all-or-null contract. */
export function decodeServerMessage(frame: Uint8Array): ServerMessage | null {
  if (frame.length === 0) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  switch (frame[0]) {
    case OP_WELCOME: {
      if (frame.length !== 7) return null;
      return {
        type: 'welcome',
        playerId: view.getUint16(1, true),
        arenaSizeWU: view.getFloat32(3, true),
      };
    }
    case OP_SNAPSHOT: {
      if (frame.length < 10) return null;
      const count = view.getUint8(9);
      if (frame.length !== 10 + count * SNAPSHOT_PLAYER_BYTES) return null;
      const players: SnapshotPlayer[] = [];
      for (let i = 0; i < count; i++) {
        const offset = 10 + i * SNAPSHOT_PLAYER_BYTES;
        const turn = view.getInt8(offset + 14);
        if (!isTurnSignal(turn)) return null;
        players.push({
          id: view.getUint16(offset, true),
          x: view.getFloat32(offset + 2, true),
          y: view.getFloat32(offset + 6, true),
          heading: view.getFloat32(offset + 10, true),
          turn,
          blockCx: view.getFloat32(offset + 15, true),
          blockCy: view.getFloat32(offset + 19, true),
        });
      }
      return {
        type: 'snapshot',
        tick: view.getUint32(1, true),
        ackSeq: view.getUint32(5, true),
        players,
      };
    }
    default:
      return null;
  }
}
