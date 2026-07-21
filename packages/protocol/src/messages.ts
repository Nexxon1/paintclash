/**
 * Binary wire format (spec §6.3, ADR-0003) — little-endian, one opcode byte,
 * shared verbatim by client and server. Decoders validate opcode, length and
 * value ranges and return `null` for anything malformed; the server drops
 * such frames at the protocol boundary (spec §8.2) instead of throwing.
 *
 * Territory/fill sync (ticket 04) is delta-shaped per PLAYER, not per tick:
 * snapshots carry only poses; a territory message replaces one player's
 * polygons when they change (spawn, fill), and a trail message full-syncs
 * one player's trail to a late joiner. Between those, clients derive trails
 * from the per-tick poses they already receive — zero standing overhead.
 * Both messages are the designated area-of-interest seam: under AoI they are
 * simply sent on interest-entry instead of join.
 */

import type { Point, Ring, Territory, TurnSignal } from '@paintclash/shared';

/** Bumped on every incompatible wire change; joins carry it. */
export const PROTOCOL_VERSION = 2;

/** Nickname cap on the wire: 16 code points, ≤ 64 UTF-8 bytes. */
export const MAX_NAME_CHARS = 16;
export const MAX_NAME_BYTES = 64;

/** Inputs per batched frame (spec §6.3 input batching, WS 20:1 budget). */
export const MAX_INPUT_BATCH = 20;

/** Hard size cap checked before parsing any client frame (spec §8.3). */
export const MAX_CLIENT_FRAME_BYTES = 128;

/**
 * Newest trail points kept in a trail sync. Purely the u16 wire capacity —
 * a real trail reaching it (~55 min of continuous turning) loses only its
 * oldest, cosmetic-for-joiners tail.
 */
export const MAX_TRAIL_POINTS = 0xffff;

const OP_JOIN = 0x01;
const OP_INPUT = 0x02;
const OP_WELCOME = 0x10;
const OP_SNAPSHOT = 0x11;
const OP_TERRITORY = 0x12;
const OP_TRAIL = 0x13;

const INPUT_ITEM_BYTES = 5; // u32 seq + i8 turn
const SNAPSHOT_PLAYER_BYTES = 15; // u16 id + 3×f32 + i8 turn
const POINT_BYTES = 8; // 2×f32

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
}

/** Why a territory message was sent — 'fill' additionally clears the trail. */
export type TerritoryReason = 'sync' | 'fill';

export type ClientMessage =
  { type: 'join'; version: number; name: string } | { type: 'input'; inputs: InputItem[] };

export type ServerMessage =
  | { type: 'welcome'; playerId: number; arenaSizeWU: number }
  | { type: 'snapshot'; tick: number; ackSeq: number; players: SnapshotPlayer[] }
  | { type: 'territory'; playerId: number; reason: TerritoryReason; territory: Territory }
  | { type: 'trail'; playerId: number; points: Point[] };

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
  });
  return frame;
}

/**
 * One player's full territory (replace, don't merge). Throws RangeError when
 * the geometry exceeds the wire's count capacities (u8 polys/rings, u16
 * points per ring) — unreachable for organically grown territories, and a
 * loud server-side bug guard if it ever is reached.
 */
export function encodeTerritory(
  playerId: number,
  reason: TerritoryReason,
  territory: Territory,
): Uint8Array {
  if (territory.length > 0xff) throw new RangeError('territory poly count exceeds u8');
  let size = 5;
  for (const poly of territory) {
    if (poly.length > 0xff) throw new RangeError('territory ring count exceeds u8');
    size += 1;
    for (const ring of poly) {
      if (ring.length > 0xffff) throw new RangeError('territory ring points exceed u16');
      size += 2 + ring.length * POINT_BYTES;
    }
  }
  const frame = new Uint8Array(size);
  const view = new DataView(frame.buffer);
  frame[0] = OP_TERRITORY;
  view.setUint16(1, playerId, true);
  frame[3] = reason === 'fill' ? 1 : 0;
  frame[4] = territory.length;
  let offset = 5;
  for (const poly of territory) {
    frame[offset] = poly.length;
    offset += 1;
    for (const ring of poly) {
      view.setUint16(offset, ring.length, true);
      offset += 2;
      for (const [x, y] of ring) {
        view.setFloat32(offset, x, true);
        view.setFloat32(offset + 4, y, true);
        offset += POINT_BYTES;
      }
    }
  }
  return frame;
}

/**
 * One player's full trail — sent to late joiners; everyone else derives
 * trails from the poses in the per-tick snapshots. Keeps the newest points
 * if the (practically unreachable) wire capacity is exceeded.
 */
export function encodeTrail(playerId: number, points: readonly Point[]): Uint8Array {
  const kept = points.length > MAX_TRAIL_POINTS ? points.slice(-MAX_TRAIL_POINTS) : points;
  const frame = new Uint8Array(5 + kept.length * POINT_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = OP_TRAIL;
  view.setUint16(1, playerId, true);
  view.setUint16(3, kept.length, true);
  kept.forEach(([x, y], i) => {
    view.setFloat32(5 + i * POINT_BYTES, x, true);
    view.setFloat32(5 + i * POINT_BYTES + 4, y, true);
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
        });
      }
      return {
        type: 'snapshot',
        tick: view.getUint32(1, true),
        ackSeq: view.getUint32(5, true),
        players,
      };
    }
    case OP_TERRITORY: {
      if (frame.length < 5) return null;
      const reasonByte = view.getUint8(3);
      if (reasonByte > 1) return null;
      const polyCount = view.getUint8(4);
      const territory: Territory = [];
      let offset = 5;
      for (let p = 0; p < polyCount; p++) {
        if (offset + 1 > frame.length) return null;
        const ringCount = view.getUint8(offset);
        offset += 1;
        // A poly without an outer ring is meaningless — malformed.
        if (ringCount < 1) return null;
        const poly: Ring[] = [];
        for (let r = 0; r < ringCount; r++) {
          if (offset + 2 > frame.length) return null;
          const pointCount = view.getUint16(offset, true);
          offset += 2;
          // Fewer than 3 points cannot bound area — malformed.
          if (pointCount < 3) return null;
          if (offset + pointCount * POINT_BYTES > frame.length) return null;
          const ring: Ring = [];
          for (let i = 0; i < pointCount; i++) {
            ring.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true)]);
            offset += POINT_BYTES;
          }
          poly.push(ring);
        }
        territory.push(poly);
      }
      if (offset !== frame.length) return null;
      return {
        type: 'territory',
        playerId: view.getUint16(1, true),
        reason: reasonByte === 1 ? 'fill' : 'sync',
        territory,
      };
    }
    case OP_TRAIL: {
      if (frame.length < 5) return null;
      const pointCount = view.getUint16(3, true);
      if (frame.length !== 5 + pointCount * POINT_BYTES) return null;
      const points: Point[] = [];
      for (let i = 0; i < pointCount; i++) {
        const offset = 5 + i * POINT_BYTES;
        points.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true)]);
      }
      return { type: 'trail', playerId: view.getUint16(1, true), points };
    }
    default:
      return null;
  }
}
