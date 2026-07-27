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

import {
  BALANCE,
  LEADERBOARD_PERCENT_SCALE,
  type DeathCause,
  type Point,
  type Ring,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';

export type { DeathCause };

/** Bumped on every incompatible wire change; joins carry it. */
export const PROTOCOL_VERSION = 5;

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

/**
 * Rows one leaderboard frame may carry: the global top N plus the recipient's
 * own row when it ranks below them (spec §2.5).
 */
export const MAX_LEADERBOARD_ROWS = BALANCE.leaderboard.topN + 1;

const OP_JOIN = 0x01;
const OP_INPUT = 0x02;
const OP_WELCOME = 0x10;
const OP_SNAPSHOT = 0x11;
const OP_TERRITORY = 0x12;
const OP_TRAIL = 0x13;
const OP_DEATH = 0x14;
const OP_LEADERBOARD = 0x15;

const DEATH_FRAME_BYTES = 6; // op + u16 victim + u16 killer + u8 cause

const LEADERBOARD_HEADER_BYTES = 2; // op + u8 row count
const LEADERBOARD_ROW_BYTES = 6; // u8 rank + u16 id + u16 pct + u8 nameLen
/**
 * Percent resolution on the wire is the shared one (the digits the HUD shows
 * and the ranking is decided at). At two decimals the full range 0…100.00 %
 * is 0…10 000, well inside u16; a third decimal would need a wider field.
 */
const MAX_PERCENT_WIRE = 100 * LEADERBOARD_PERCENT_SCALE;

const INPUT_ITEM_BYTES = 5; // u32 seq + i8 turn
const INPUT_HEADER_BYTES = 6; // op + u8 count + u32 viewTick
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

/**
 * One leaderboard row (spec §2.5). The metric is exclusively the share of the
 * map; the name rides along because the leaderboard is the only place the
 * server reveals a nickname (ticket 13 owns the naming policy itself).
 */
export interface LeaderboardRow {
  /** 1-based global rank. Fits a byte: ranks never exceed `maxConnections`. */
  rank: number;
  playerId: number;
  /** Share of the arena in percent (0…100), wire-quantized to hundredths. */
  areaPct: number;
  name: string;
}

export type ClientMessage =
  | { type: 'join'; version: number; name: string }
  | {
      type: 'input';
      /**
       * Server tick the client was RENDERING opponents at when the newest
       * input was sampled (ticket 07 rewind, Source-style lag report);
       * 0 = no view yet. Timing metadata like `seq` — the server clamps it
       * to `LIMITS.rewindMaxTicks`, it can assert no game state.
       */
      viewTick: number;
      inputs: InputItem[];
    };

export type ServerMessage =
  | { type: 'welcome'; playerId: number; arenaSizeWU: number }
  | { type: 'snapshot'; tick: number; ackSeq: number; players: SnapshotPlayer[] }
  | { type: 'territory'; playerId: number; reason: TerritoryReason; territory: Territory }
  | { type: 'trail'; playerId: number; points: Point[] }
  | { type: 'death'; victimId: number; killerId: number; cause: DeathCause }
  | { type: 'leaderboard'; rows: LeaderboardRow[] };

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

/**
 * Batched steer intents plus the view-tick report — the only things a
 * client may say per spec §8.2 (both are timing metadata; neither can
 * assert game state).
 */
export function encodeInput(inputs: readonly InputItem[], viewTick: number): Uint8Array {
  if (inputs.length < 1 || inputs.length > MAX_INPUT_BATCH) {
    throw new RangeError(`input batch must hold 1..${String(MAX_INPUT_BATCH)} items`);
  }
  const frame = new Uint8Array(INPUT_HEADER_BYTES + inputs.length * INPUT_ITEM_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = OP_INPUT;
  frame[1] = inputs.length;
  view.setUint32(2, viewTick, true);
  inputs.forEach((input, i) => {
    const offset = INPUT_HEADER_BYTES + i * INPUT_ITEM_BYTES;
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
 * One death (spec §2.1): who died and who caused it — `killerId` equals
 * `victimId` for a self-cut. Doubles as the kill event on the killer's
 * client (ticket 05 "Tod-Event + Kill-Event"). The victim's respawn arrives
 * as the territory sync + snapshot of the same tick.
 */
const DEATH_CAUSES = ['trailCut', 'headOn', 'totalLoss'] as const satisfies readonly DeathCause[];

export function encodeDeath(victimId: number, killerId: number, cause: DeathCause): Uint8Array {
  const frame = new Uint8Array(DEATH_FRAME_BYTES);
  const view = new DataView(frame.buffer);
  frame[0] = OP_DEATH;
  view.setUint16(1, victimId, true);
  view.setUint16(3, killerId, true);
  frame[5] = DEATH_CAUSES.indexOf(cause);
  return frame;
}

/**
 * One recipient's view of the global ranking (spec §2.5): the top rows plus,
 * appended, the recipient's own row when it ranks below them. Sent whole —
 * the client replaces its board, never merges. Percent is clamped into
 * [0, 100] (float noise in an area sum is not worth a dropped frame), while
 * a row count or rank out of wire range is a server bug and throws.
 */
export function encodeLeaderboard(rows: readonly LeaderboardRow[]): Uint8Array {
  if (rows.length > MAX_LEADERBOARD_ROWS) throw new RangeError('leaderboard row count exceeds cap');
  const names = rows.map((row) => textEncoder.encode(capName(row.name)));
  let size = LEADERBOARD_HEADER_BYTES;
  for (const name of names) size += LEADERBOARD_ROW_BYTES + name.length;
  const frame = new Uint8Array(size);
  const view = new DataView(frame.buffer);
  frame[0] = OP_LEADERBOARD;
  frame[1] = rows.length;
  let offset = LEADERBOARD_HEADER_BYTES;
  rows.forEach((row, i) => {
    const name = names[i] ?? new Uint8Array();
    if (row.rank < 1 || row.rank > 0xff) throw new RangeError('leaderboard rank exceeds u8');
    frame[offset] = row.rank;
    view.setUint16(offset + 1, row.playerId, true);
    const pct = Math.round(row.areaPct * LEADERBOARD_PERCENT_SCALE);
    view.setUint16(offset + 3, Math.min(MAX_PERCENT_WIRE, Math.max(0, pct)), true);
    frame[offset + 5] = name.length;
    frame.set(name, offset + LEADERBOARD_ROW_BYTES);
    offset += LEADERBOARD_ROW_BYTES + name.length;
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
      if (frame.length < INPUT_HEADER_BYTES) return null;
      const count = view.getUint8(1);
      if (count < 1 || count > MAX_INPUT_BATCH) return null;
      if (frame.length !== INPUT_HEADER_BYTES + count * INPUT_ITEM_BYTES) return null;
      const viewTick = view.getUint32(2, true);
      const inputs: InputItem[] = [];
      for (let i = 0; i < count; i++) {
        const offset = INPUT_HEADER_BYTES + i * INPUT_ITEM_BYTES;
        const seq = view.getUint32(offset, true);
        const turn = view.getInt8(offset + 4);
        if (!isTurnSignal(turn)) return null;
        inputs.push({ seq, turn });
      }
      return { type: 'input', viewTick, inputs };
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
    case OP_LEADERBOARD: {
      if (frame.length < LEADERBOARD_HEADER_BYTES) return null;
      const count = view.getUint8(1);
      if (count > MAX_LEADERBOARD_ROWS) return null;
      const rows: LeaderboardRow[] = [];
      let offset = LEADERBOARD_HEADER_BYTES;
      for (let i = 0; i < count; i++) {
        if (offset + LEADERBOARD_ROW_BYTES > frame.length) return null;
        const rank = view.getUint8(offset);
        if (rank < 1) return null; // ranks are 1-based (spec §2.5)
        const pct = view.getUint16(offset + 3, true);
        if (pct > MAX_PERCENT_WIRE) return null;
        const nameLen = view.getUint8(offset + 5);
        const nameStart = offset + LEADERBOARD_ROW_BYTES;
        if (nameLen > MAX_NAME_BYTES || nameStart + nameLen > frame.length) return null;
        const name = textDecoder.decode(frame.subarray(nameStart, nameStart + nameLen));
        if (Array.from(name).length > MAX_NAME_CHARS) return null;
        rows.push({
          rank,
          playerId: view.getUint16(offset + 1, true),
          areaPct: pct / LEADERBOARD_PERCENT_SCALE,
          name,
        });
        offset = nameStart + nameLen;
      }
      if (offset !== frame.length) return null;
      return { type: 'leaderboard', rows };
    }
    case OP_DEATH: {
      if (frame.length !== DEATH_FRAME_BYTES) return null;
      const cause = DEATH_CAUSES[view.getUint8(5)];
      if (cause === undefined) return null;
      return {
        type: 'death',
        victimId: view.getUint16(1, true),
        killerId: view.getUint16(3, true),
        cause,
      };
    }
    default:
      return null;
  }
}
