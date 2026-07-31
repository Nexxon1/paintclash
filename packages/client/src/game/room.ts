/**
 * Private rooms, client side (ticket 14, spec §2.6): the link, the lobby's
 * display model, the refusal messages and the host's own secret. No DOM — the
 * card that paints this lives in `render/room-hud.ts`, and the rules the server
 * enforces live in `shared/room.ts`, which this module reads rather than
 * restates.
 */

import {
  ROOM_CLOSE,
  defaultMapSizeWU,
  normalizeRoomCode,
  roomShareLink,
  sanitizeRoomConfig,
  type RoomConfig,
} from '@paintclash/shared';

import { playerCssColor } from './colors.js';
import { readStored, writeStored, type LocalStore } from './storage.js';

import type { LobbyState } from '@paintclash/protocol';

/**
 * What it takes to enter one room: its code, plus the host secret if this browser
 * created it (null for everyone who followed a link). The same pair the create
 * endpoint answers with and `HostTokens` remembers.
 */
export interface RoomEntry {
  code: string;
  hostToken: string | null;
}

/** One row of the lobby list. */
export interface LobbyMemberView {
  label: string;
  /** The color this player will actually play in — the own one is the blue. */
  color: string;
  isSelf: boolean;
  isHost: boolean;
}

/** Everything the lobby card shows (spec §2.6). */
export interface LobbyViewModel {
  code: string;
  /** The link to share — the code on the origin the player is already on. */
  link: string;
  members: LobbyMemberView[];
  /** "2 / 8" — how full the room is against its own limit. */
  countText: string;
  /** May edit the settings and press start. */
  isHost: boolean;
  config: RoomConfig;
}

/**
 * The room code a link asks for, or null. Uses the shared normalizer, so a code
 * this accepts is exactly a code the router will route — the client never opens
 * a socket the router would answer with a 400.
 */
export function roomCodeWish(search: string): string | null {
  const wish = new URLSearchParams(search).get('room');
  return wish === null ? null : normalizeRoomCode(wish);
}

/**
 * Why a room closed the socket, in words — or null when the close was not a
 * room refusal (an ordinary disconnect, the arena's own codes). Each of the
 * three asks the player for something different, which is the whole reason the
 * codes are distinct (`ROOM_CLOSE`).
 */
export function roomCloseMessage(code: number): string | null {
  switch (code) {
    case ROOM_CLOSE.unknown:
      return 'Diesen Raum gibt es nicht (mehr) — Code prüfen.';
    case ROOM_CLOSE.full:
      return 'Der Raum ist voll.';
    case ROOM_CLOSE.running:
      return 'Das Spiel läuft schon und lässt niemanden mehr nachrücken.';
    default:
      return null;
  }
}

/**
 * The lobby as the card shows it. `origin` is required rather than defaulted: a
 * plausible-but-wrong invitation link is worse than a compile error.
 */
export function lobbyView(lobby: LobbyState, origin: string): LobbyViewModel {
  return {
    code: lobby.code,
    link: roomShareLink(origin, lobby.code),
    countText: `${String(lobby.members.length)} / ${String(lobby.config.playerLimit)}`,
    isHost: lobby.members.some((member) => member.playerId === lobby.selfId && member.host),
    config: lobby.config,
    members: lobby.members.map((member) => ({
      label: member.name,
      // The same mapping the scene and the leaderboard use, so the lobby is the
      // first honest look at who is who (spec §2.5: the color is the identity).
      color: playerCssColor(member.playerId, lobby.selfId),
      isSelf: member.playerId === lobby.selfId,
      isHost: member.host,
    })),
  };
}

/** What the four settings controls currently read, before anything judges them. */
export interface RoomFormFields {
  playerLimit: string;
  mapSizeWU: string;
  botTarget: string;
  lateJoin: boolean;
}

/**
 * A number field's value, or `fallback` when the field is **blank**. A cleared
 * field means "I did not answer", not "the smallest legal number" — and
 * `Number('')` is 0, which `sanitizeRoomConfig` would dutifully clamp up to the
 * minimum. Clearing the player count would then read as "a room for two".
 */
export function typedNumber(raw: string, fallback: number): number {
  return raw.trim() === '' ? fallback : Number(raw);
}

/**
 * The settings form as typed, made legal against the room it is editing. The
 * server applies the very same policy to whatever arrives (and has the last
 * word), so this only makes the card honest about what it is asking for.
 */
export function roomFormConfig(typed: RoomFormFields, current: RoomConfig): RoomConfig {
  return sanitizeRoomConfig({
    playerLimit: typedNumber(typed.playerLimit, current.playerLimit),
    mapSizeWU: typedNumber(typed.mapSizeWU, current.mapSizeWU),
    botTarget: typedNumber(typed.botTarget, current.botTarget),
    lateJoin: typed.lateJoin,
  });
}

/**
 * The map size after the host moved the player limit. It follows the spec §10.4
 * ladder for as long as it is still ON the ladder, and stops the moment the host
 * has typed a size of their own — spec §2.6 gives the size to the host, so
 * re-deriving one they chose would undo the choice behind their back.
 */
export function mapSizeAfterLimitChange(sizeWU: number, from: number, to: number): number {
  return sizeWU === defaultMapSizeWU(from) ? defaultMapSizeWU(to) : sizeWU;
}

/** Envelope key — versioned like the records store (ADR-0006 seam 4). */
const TOKENS_KEY = 'paintclash.rooms.v1';

/**
 * Rooms remembered before the newest one is dropped. Rooms are throwaway (spec
 * §2.6: a code is free again `graceSeconds` after the last player leaves), so a
 * handful is all that can still be live — this only has to survive a reload,
 * not a week.
 */
const MAX_REMEMBERED = 8;

/**
 * The host secrets this browser holds (ticket 14). A host who reloads has to
 * come back as the host, and the token only ever existed in the response to the
 * POST that created the room — so it is kept, per code, next to the other
 * account-less state (spec §5.3: local, never server-side).
 *
 * Denied storage degrades to session-only: the host can still host the room they
 * just created, they only lose it on reload. That is the same rule the records
 * and settings stores follow (`storage.ts`).
 */
export class HostTokens {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly store: LocalStore | null) {
    const raw = readStored(store, TOKENS_KEY);
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      for (const [code, token] of Object.entries(parsed)) {
        if (typeof token === 'string') this.tokens.set(code, token);
      }
    } catch {
      // A corrupted envelope is no reason to break the join card — the player
      // simply is not the host of anything until they create a room again.
    }
  }

  /** The secret for this room, or null if this browser never created it. */
  of(code: string): string | null {
    return this.tokens.get(code) ?? null;
  }

  /** Remember a freshly created room's secret. */
  remember(code: string, token: string): void {
    this.tokens.set(code, token);
    // Insertion-ordered, so dropping from the front drops the oldest.
    while (this.tokens.size > MAX_REMEMBERED) {
      const oldest = this.tokens.keys().next();
      if (oldest.done) break;
      this.tokens.delete(oldest.value);
    }
    writeStored(this.store, TOKENS_KEY, JSON.stringify(Object.fromEntries(this.tokens)));
  }
}
