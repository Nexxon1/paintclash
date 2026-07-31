import { describe, expect, it } from 'vitest';

import { BALANCE } from './balance.js';
import {
  ROOM_CODE,
  defaultMapSizeWU,
  defaultRoomConfig,
  normalizeRoomCode,
  roomCodeFrom,
  roomPath,
  roomShareLink,
  sanitizeRoomConfig,
} from './room.js';

describe('room code alphabet (spec §8.3 point 6)', () => {
  it('excludes every confusable character', () => {
    // The spec names the pairs: 0/O and 1/I/l. Both members of each pair are
    // gone, so no transcription of a valid code can produce one — a typed 0 is
    // therefore a typo to reject, never a character to map.
    for (const char of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_CODE.alphabet, `${char} must not be part of the alphabet`).not.toContain(char);
    }
    // Uppercase-only, so `normalizeRoomCode` can be case-insensitive by
    // uppercasing rather than by carrying a second mapping table.
    expect(ROOM_CODE.alphabet).toBe(ROOM_CODE.alphabet.toUpperCase());
    expect(new Set(ROOM_CODE.alphabet).size).toBe(ROOM_CODE.alphabet.length);
  });

  it("keeps the ~10⁹ combinations the spec's obscurity argument rests on", () => {
    // "Freundliche Obskurität": 6 characters out of 31 ≈ 8.9 × 10⁸. The
    // enumeration argument in spec §8.3 is stated against this number, so a
    // shortened code or a thinned alphabet has to fail here.
    expect(ROOM_CODE.length).toBe(6);
    expect(ROOM_CODE.alphabet.length ** ROOM_CODE.length).toBeGreaterThan(5e8);
  });
});

describe('normalizeRoomCode', () => {
  it('is case-insensitive and forgives the separators people type', () => {
    expect(normalizeRoomCode('pq7k3m')).toBe('PQ7K3M');
    expect(normalizeRoomCode('PQ7-K3M')).toBe('PQ7K3M');
    expect(normalizeRoomCode('  pq7 k3m ')).toBe('PQ7K3M');
    expect(normalizeRoomCode('pq7_k3m')).toBe('PQ7K3M');
  });

  it('refuses anything that is not exactly one code', () => {
    // Wrong length, characters outside the alphabet, and the confusables the
    // alphabet deliberately dropped (a typed 0/O/1/I/L is a typo, not a hint).
    for (const raw of ['', 'PQ7K3', 'PQ7K3MM', 'PQ7K3!', 'PQ7K30', 'PQ7K3O', 'PQ7K3I', 'ÄQ7K3M']) {
      expect(normalizeRoomCode(raw), `"${raw}" must not normalize`).toBeNull();
    }
  });
});

describe('roomCodeFrom', () => {
  it('maps bytes to a code of exactly the right shape', () => {
    const code = roomCodeFrom(new Uint8Array([0, 1, 2, 3, 4, 5]));
    expect(code).toBe([0, 1, 2, 3, 4, 5].map((byte) => ROOM_CODE.alphabet[byte]).join(''));
    // Whatever comes out must be something the router can route by.
    expect(normalizeRoomCode(code ?? '')).toBe(code);
  });

  it('rejects the biased tail of the byte range instead of folding it in', () => {
    // 256 is not a multiple of 31: bytes ≥ 248 would make the first 8 symbols
    // slightly likelier than the rest. They are skipped, not wrapped — the
    // whole point of the code is that it is hard to guess.
    const limit = 256 - (256 % ROOM_CODE.alphabet.length);
    const bytes = new Uint8Array([limit, limit + 1, 255, 0, 1, 2, 3, 4, 5]);
    expect(roomCodeFrom(bytes)).toBe(
      [0, 1, 2, 3, 4, 5].map((byte) => ROOM_CODE.alphabet[byte]).join(''),
    );
  });

  it('returns null when the entropy ran out, so the caller draws again', () => {
    expect(roomCodeFrom(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(roomCodeFrom(new Uint8Array())).toBeNull();
  });

  it('reaches every symbol of the alphabet', () => {
    // A fold that could never emit the last symbols would quietly shrink the
    // key space this whole scheme is sized by.
    const seen = new Set<string>();
    for (let byte = 0; byte < ROOM_CODE.alphabet.length; byte++) {
      const code = roomCodeFrom(new Uint8Array(Array.from({ length: 6 }, () => byte)));
      if (code) seen.add(code[0] ?? '');
    }
    expect(seen.size).toBe(ROOM_CODE.alphabet.length);
  });
});

describe('the invitation (one spelling for three callers)', () => {
  it('is the code on the origin the player is already on', () => {
    // Whatever host the game is reached under — the deployed worker, a tunnel,
    // localhost — a copied link has to work from where the player is.
    expect(roomShareLink('http://127.0.0.1:8787', 'PQ7K3M')).toBe(
      'http://127.0.0.1:8787/?room=PQ7K3M',
    );
    expect(roomShareLink('https://paintclash.example', 'PQ7K3M')).toBe(
      'https://paintclash.example/?room=PQ7K3M',
    );
  });

  it('is the same path the client puts in the address bar', () => {
    // The create endpoint's link, the lobby card's link and the rewritten
    // address bar all read this — a second spelling would mean a copied link
    // that works and a bookmarked one that does not.
    expect(roomPath('PQ7K3M')).toBe('/?room=PQ7K3M');
    expect(roomShareLink('https://x', 'PQ7K3M')).toBe(`https://x${roomPath('PQ7K3M')}`);
  });

  it('produces a link its own reader accepts', () => {
    // The round trip that matters: what the create endpoint hands out is what
    // `roomCodeWish` reads back off the address bar.
    const code = 'PQ7K3M';
    expect(new URL(roomShareLink('https://x', code)).searchParams.get('room')).toBe(code);
  });
});

describe('defaultMapSizeWU (spec §10.4 ladder)', () => {
  it("reproduces the spec's own table", () => {
    // `Kante = √(Spieler × 5000)`, read at the ten the spec quotes it in.
    expect(defaultMapSizeWU(2)).toBe(100);
    expect(defaultMapSizeWU(4)).toBe(140);
    expect(defaultMapSizeWU(8)).toBe(200);
    expect(defaultMapSizeWU(16)).toBe(280);
  });

  it("lands the 8-player default on the public arena's size", () => {
    // Not a coincidence worth losing: the same 5000 WU²/player rule sizes the
    // public arena and its bot target (`BALANCE.bots.areaPerEntityWU2`).
    expect(defaultMapSizeWU(BALANCE.room.playerLimitDefault)).toBe(BALANCE.arena.sizeWU);
  });

  it('stays inside the playable band whatever it is asked', () => {
    expect(defaultMapSizeWU(0)).toBe(BALANCE.room.mapSizeMinWU);
    expect(defaultMapSizeWU(1000)).toBe(BALANCE.room.mapSizeMaxWU);
  });
});

describe('sanitizeRoomConfig (the one policy the host UI and the server share)', () => {
  it("defaults an absent wish to the spec's room", () => {
    // Spec §2.6/§10.4: 8 players, the matching map, bots OFF, late join ON.
    expect(sanitizeRoomConfig(undefined)).toEqual({
      mapSizeWU: 200,
      playerLimit: 8,
      botTarget: 0,
      lateJoin: true,
    });
    expect(sanitizeRoomConfig(null)).toEqual(defaultRoomConfig());
    expect(sanitizeRoomConfig('nonsense')).toEqual(defaultRoomConfig());
    expect(sanitizeRoomConfig({})).toEqual(defaultRoomConfig());
  });

  it('keeps a legal wish verbatim', () => {
    expect(
      sanitizeRoomConfig({ mapSizeWU: 120, playerLimit: 4, botTarget: 3, lateJoin: false }),
    ).toEqual({ mapSizeWU: 120, playerLimit: 4, botTarget: 3, lateJoin: false });
  });

  it("clamps the player limit to the spec's 2…16", () => {
    expect(sanitizeRoomConfig({ playerLimit: 1 }).playerLimit).toBe(BALANCE.room.playerLimitMin);
    expect(sanitizeRoomConfig({ playerLimit: 99 }).playerLimit).toBe(BALANCE.room.playerLimitMax);
    expect(sanitizeRoomConfig({ playerLimit: 4.7 }).playerLimit).toBe(4);
    // Not a number at all → the default, not a clamp of NaN.
    expect(sanitizeRoomConfig({ playerLimit: 'eight' }).playerLimit).toBe(
      BALANCE.room.playerLimitDefault,
    );
  });

  it('derives the map size from the limit when the host said nothing', () => {
    expect(sanitizeRoomConfig({ playerLimit: 2 }).mapSizeWU).toBe(100);
    expect(sanitizeRoomConfig({ playerLimit: 16 }).mapSizeWU).toBe(280);
    // …and only then. An explicit size is the host's to choose (spec §2.6:
    // "frei wählbar") and must not be second-guessed by the ladder.
    expect(sanitizeRoomConfig({ playerLimit: 16, mapSizeWU: 100 }).mapSizeWU).toBe(100);
  });

  it('clamps a freely chosen map size into the playable band', () => {
    expect(sanitizeRoomConfig({ mapSizeWU: 1 }).mapSizeWU).toBe(BALANCE.room.mapSizeMinWU);
    expect(sanitizeRoomConfig({ mapSizeWU: 99_999 }).mapSizeWU).toBe(BALANCE.room.mapSizeMaxWU);
    expect(sanitizeRoomConfig({ mapSizeWU: 123.4 }).mapSizeWU).toBe(123);
    expect(sanitizeRoomConfig({ mapSizeWU: Number.NaN }).mapSizeWU).toBe(200);
    expect(sanitizeRoomConfig({ mapSizeWU: Number.POSITIVE_INFINITY }).mapSizeWU).toBe(200);
  });

  it("caps the bot target at the room's own limit (spec §10.4)", () => {
    // "bei Aktivierung füllt dieselbe clamp-Regel bis zum Raumlimit" — a room
    // for 4 cannot be told to hold 12 entities.
    expect(sanitizeRoomConfig({ playerLimit: 4, botTarget: 12 }).botTarget).toBe(4);
    expect(sanitizeRoomConfig({ botTarget: -3 }).botTarget).toBe(0);
    expect(sanitizeRoomConfig({ botTarget: 2.9 }).botTarget).toBe(2);
    expect(sanitizeRoomConfig({ botTarget: 'many' }).botTarget).toBe(0);
  });

  it('treats late join as on unless it was explicitly switched off', () => {
    expect(sanitizeRoomConfig({ lateJoin: false }).lateJoin).toBe(false);
    expect(sanitizeRoomConfig({ lateJoin: true }).lateJoin).toBe(true);
    // Anything else is not a decision — the spec's default stands.
    expect(sanitizeRoomConfig({ lateJoin: 'no' }).lateJoin).toBe(true);
    expect(sanitizeRoomConfig({ lateJoin: 0 }).lateJoin).toBe(true);
  });

  it('is idempotent, so the host preview and the server agree', () => {
    // Same contract as the nickname policy: what the lobby shows IS what the
    // arena will be built with, because sanitizing twice changes nothing.
    for (const wish of [
      {},
      { playerLimit: 99, botTarget: 99 },
      { mapSizeWU: 1, lateJoin: false },
      { playerLimit: 3, mapSizeWU: 137.9, botTarget: 1.2 },
    ]) {
      const once = sanitizeRoomConfig(wish);
      expect(sanitizeRoomConfig(once)).toEqual(once);
    }
  });
});
