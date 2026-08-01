/**
 * Private-room policy (spec §2.6, §8.3 point 6, §10.4, ticket 14) — the room
 * **code format** and the **host settings** both ends of the wire must read
 * identically.
 *
 * Lives in `shared` for the same reason the nickname policy does: the server
 * enforces and the client pre-checks, so one implementation of one rule. A
 * host who drags the player limit to 20 must see the 16 the arena will actually
 * be built with (`sanitizeRoomConfig` is idempotent, so the lobby preview *is*
 * the server's answer), and a typed room code must normalize to the very string
 * the router addresses the Durable Object by (`idFromName(code)`, ADR-0004) —
 * two normalizers would send a player to a room that does not exist.
 *
 * Nothing here reaches for randomness: `roomCodeFrom` takes the bytes, so the
 * module stays pure and the code generator is testable without stubbing
 * `crypto` (the caller draws from it — see `router.ts`).
 */

import { BALANCE } from './balance.js';

/**
 * The room code's wire format. Not a balance knob — a code that changed shape
 * would invalidate every link already shared, so it sits here beside the policy
 * that validates it (exactly like `NICKNAME` in `nickname.ts`).
 *
 * The alphabet drops both members of every confusable pair spec §8.3 names
 * (`0`/`O`, `1`/`I`/`l`), which is what makes a code safe to read out loud: a
 * transcription of a valid code can never *contain* one of them, so a typed `0`
 * is unambiguously a typo to reject rather than a character to guess at.
 * Uppercase-only, so case-insensitivity is one `toUpperCase()` and not a second
 * mapping table that could disagree with this one.
 *
 * 31 symbols over 6 places ≈ 8.9 × 10⁸ combinations — the "~10⁹" the spec's
 * friendly-obscurity argument is stated against (moderate entropy + very few
 * live rooms + a join-rate limit + throwaway nature).
 */
export const ROOM_CODE = Object.freeze({
  alphabet: '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
  length: 6,
});

/** Everything a player may type between a code's characters and still mean it. */
const CODE_SEPARATORS = /[\s\-_]/g;

// The close codes a room refuses with live in `close.ts`, beside the arena's —
// they share the 4000–4999 range, so one file owns all of them.

/**
 * The host's settings for one private room (spec §2.6). Sanitized by
 * construction — a `RoomConfig` is only ever produced by
 * `sanitizeRoomConfig`, so anything holding one already holds legal values.
 */
export interface RoomConfig {
  /** Arena edge length in WU (spec §2.6: default per player count, free). */
  mapSizeWU: number;
  /** Concurrent players the room admits, `playerLimitMin`…`playerLimitMax`. */
  playerLimit: number;
  /**
   * Entities the room is kept populated to while at least one human plays —
   * the public arena's rule (`bots = clamp(target − humans, 0, maxBots)`)
   * with the host's number as the target. 0 = bots off, the default.
   */
  botTarget: number;
  /** Drop-in per link while the game runs (spec §2.6, default on). */
  lateJoin: boolean;
}

/**
 * The canonical form of a typed or pasted room code, or `null` when it is not
 * one. Uppercased (case-insensitive per spec §8.3) and forgiving about the
 * separators people add when they write a code down — but strict about the
 * alphabet: every remaining character must be one the generator can emit.
 */
export function normalizeRoomCode(raw: string): string | null {
  const code = raw.replace(CODE_SEPARATORS, '').toUpperCase();
  if (code.length !== ROOM_CODE.length) return null;
  for (const char of code) {
    if (!ROOM_CODE.alphabet.includes(char)) return null;
  }
  return code;
}

/**
 * The path a room is reachable at. One source, because three places have to
 * agree on what an invitation looks like: the link the create endpoint hands
 * back, the link the lobby card offers for sharing, and the address bar the
 * client rewrites so a reload comes back to the same room. Two spellings would
 * mean a copied link that works and a bookmarked one that does not.
 */
export function roomPath(code: string): string {
  return `/?room=${code}`;
}

/**
 * That path on `origin` — the link a player actually shares.
 *
 * Takes the origin rather than a full URL to parse, because this package is
 * deliberately environment-neutral (`lib: ES2023`, see `tsconfig.base.json`):
 * `URL` is a global in browsers and in workerd but not in the language, and one
 * helper is not a reason to widen what `shared` assumes about its host. Each
 * caller already has its origin — `location.origin`, or the request's URL.
 */
export function roomShareLink(origin: string, code: string): string {
  return `${origin}${roomPath(code)}`;
}

/**
 * Fold random bytes into a room code, or `null` if `bytes` ran dry — draw more
 * and call again (the caller owns the randomness, see the module comment).
 *
 * Bytes in the biased tail of the range are **skipped, not wrapped**: 256 is
 * not a multiple of 31, so a plain modulo would make the first eight symbols
 * ~3 % likelier than the rest. That is a small bias, and irrelevant to anything
 * but the one property this code has — being hard to guess — which is exactly
 * why it is not spent for free.
 */
export function roomCodeFrom(bytes: Uint8Array): string | null {
  const symbols = ROOM_CODE.alphabet.length;
  const unbiasedLimit = 256 - (256 % symbols);
  let code = '';
  for (const byte of bytes) {
    if (byte >= unbiasedLimit) continue;
    // `charAt` rather than an index: the modulo is in range by construction,
    // and this says so to the type system instead of asserting it.
    code += ROOM_CODE.alphabet.charAt(byte % symbols);
    if (code.length === ROOM_CODE.length) return code;
  }
  return null;
}

/**
 * Map edge length a room of this size gets when the host picks nothing — spec
 * §10.4's `Kante = √(Spieler × 5000)`, read at the ten the spec quotes the
 * ladder in (2p 100 / 4p 140 / 8p 200 / 16p 280 WU). Rounding to tens is what
 * makes the derived number equal the published table instead of 141 and 283.
 */
export function defaultMapSizeWU(playerLimit: number): number {
  const edge = Math.sqrt(playerLimit * BALANCE.room.areaPerPlayerWU2);
  return clampMapSize(Math.round(edge / 10) * 10);
}

/** A room with nothing configured — the spec's defaults, as §2.6/§10.4 list them. */
export function defaultRoomConfig(playerLimit = BALANCE.room.playerLimitDefault): RoomConfig {
  return {
    mapSizeWU: defaultMapSizeWU(playerLimit),
    playerLimit,
    botTarget: BALANCE.room.botTargetDefault,
    lateJoin: BALANCE.room.lateJoinDefault,
  };
}

/**
 * The host's wish, made legal. Takes `unknown` because that is what it really
 * gets: a JSON body at the create endpoint, a decoded settings frame from a
 * lobby socket, a record read back out of DO storage after a deploy. Every
 * field is judged on its own, and an unusable one falls back to its default
 * rather than poisoning the rest of the room.
 *
 * Two rules worth naming:
 *
 * - A missing map size is **derived** from the player limit (the §10.4 ladder),
 *   an explicit one is only **clamped** — spec §2.6 gives the size to the host
 *   ("frei wählbar"), so a deliberate 100 WU duel field for 16 players is a
 *   choice to respect, not a mistake to correct.
 * - The bot target is capped by the room's own player limit, per §10.4's "bei
 *   Aktivierung füllt dieselbe clamp-Regel bis zum Raumlimit". The hard bot
 *   ceiling stays `BALANCE.bots.maxBots` and is applied where bots are actually
 *   spawned (`ArenaCore.manageBots`) — that one is a CPU guard, not a host
 *   setting.
 *
 * Idempotent: sanitizing a sanitized config returns it unchanged, which is what
 * lets the lobby show the server's answer before the server has answered.
 */
export function sanitizeRoomConfig(raw: unknown): RoomConfig {
  const wish: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const playerLimit = clampInt(
    wish.playerLimit,
    BALANCE.room.playerLimitMin,
    BALANCE.room.playerLimitMax,
    BALANCE.room.playerLimitDefault,
  );
  const size = wish.mapSizeWU;
  return {
    mapSizeWU:
      typeof size === 'number' && Number.isFinite(size)
        ? clampMapSize(Math.floor(size))
        : defaultMapSizeWU(playerLimit),
    playerLimit,
    botTarget: clampInt(wish.botTarget, 0, playerLimit, BALANCE.room.botTargetDefault),
    lateJoin: typeof wish.lateJoin === 'boolean' ? wish.lateJoin : BALANCE.room.lateJoinDefault,
  };
}

/** Into the playable band (see `BALANCE.room.mapSizeMinWU`). */
function clampMapSize(sizeWU: number): number {
  return Math.min(BALANCE.room.mapSizeMaxWU, Math.max(BALANCE.room.mapSizeMinWU, sizeWU));
}

/**
 * A whole number in `[min, max]`, or `fallback` when the value is not a number
 * at all. Truncating rather than rounding: a slider that reports 4.7 players
 * means "four seats and a rendering artifact", never five.
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
