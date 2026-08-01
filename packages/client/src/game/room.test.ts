import { ARENA_CLOSE, BALANCE, ROOM_CLOSE, defaultRoomConfig } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { SELF_COLOR_CSS } from './colors.js';
import {
  HostTokens,
  lobbyView,
  mapSizeAfterLimitChange,
  refusalMessage,
  roomCodeWish,
  roomFormConfig,
} from './room.js';

import type { LobbyState } from '@paintclash/protocol';

/** The origin the lobby is being shown on — what the share link is built on. */
const HERE = 'https://paintclash.example';

function lobby(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    code: 'PQ7K3M',
    config: defaultRoomConfig(),
    selfId: 2,
    members: [
      { playerId: 1, name: 'Ada', host: true },
      { playerId: 2, name: 'Grace', host: false },
    ],
    ...overrides,
  };
}

describe('roomCodeWish (the code in a shared link)', () => {
  it('reads and normalizes the code a link carries', () => {
    expect(roomCodeWish('?room=pq7k3m')).toBe('PQ7K3M');
    expect(roomCodeWish('?foo=1&room=PQ7-K3M&bar=2')).toBe('PQ7K3M');
  });

  it('is null when there is no room in the link', () => {
    expect(roomCodeWish('')).toBeNull();
    expect(roomCodeWish('?')).toBeNull();
    expect(roomCodeWish('?name=Ada')).toBeNull();
  });

  it('is null for a code that could not be one', () => {
    // Same rule the router applies (`shared/room.ts`), so the client never
    // opens a socket the router would refuse with a 400.
    expect(roomCodeWish('?room=nope')).toBeNull();
    expect(roomCodeWish('?room=PQ7K30')).toBeNull();
  });
});

describe('refusalMessage', () => {
  it('names each refusal a room can answer with', () => {
    // The player has to know what to do next, and these three call for three
    // different things: check the code, wait for a seat, wait for the round.
    expect(refusalMessage(ROOM_CLOSE.unknown)).toMatch(/Raum/);
    expect(refusalMessage(ROOM_CLOSE.full)).toMatch(/voll/);
    expect(refusalMessage(ROOM_CLOSE.running)).toMatch(/läuft/);
  });

  it('names each refusal the arena itself can answer with (ticket 15)', () => {
    // "Arena voll" is the population limit (spec §8.3 point 4) and asks for
    // patience; the per-address cap asks the player to close a window. Without
    // words, both arrive as the same blank 1006 that a crashed server produces.
    expect(refusalMessage(ARENA_CLOSE.full)).toMatch(/Arena/);
    expect(refusalMessage(ARENA_CLOSE.tooManyConnections)).toMatch(/Verbindungen/);
  });

  it('says something different for every refusal', () => {
    const messages = [...Object.values(ROOM_CLOSE), ...Object.values(ARENA_CLOSE)].map((code) =>
      refusalMessage(code),
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('has nothing to say about an ordinary close or a protocol kick', () => {
    // 1000/1006/1012 are disconnects and 1008 is a client that broke the wire
    // format — nothing a player can act on, so the generic line covers them.
    for (const code of [1000, 1006, 1008, 1012, 1013]) {
      expect(refusalMessage(code)).toBeNull();
    }
  });
});

describe('lobbyView', () => {
  it('marks the recipient and the host', () => {
    const view = lobbyView(lobby(), HERE);
    expect(view.members.map((member) => member.label)).toEqual(['Ada', 'Grace']);
    expect(view.members.map((member) => member.isHost)).toEqual([true, false]);
    expect(view.members.map((member) => member.isSelf)).toEqual([false, true]);
    // The recipient is not the host here, so the settings are read-only.
    expect(view.isHost).toBe(false);
  });

  it('gives the recipient the reserved own-blue, like every other panel', () => {
    // The lobby is the first place a player sees their color, and it has to be
    // the color they will play in (spec §2.5: the swatch is the identity).
    const view = lobbyView(lobby(), HERE);
    expect(view.members[1]?.color).toBe(SELF_COLOR_CSS);
    expect(view.members[0]?.color).not.toBe(SELF_COLOR_CSS);
  });

  it('lets the host edit and start', () => {
    const view = lobbyView(lobby({ selfId: 1 }), HERE);
    expect(view.isHost).toBe(true);
  });

  it('shows how full the room is and what to share', () => {
    const view = lobbyView(lobby(), HERE);
    expect(view.countText).toBe('2 / 8');
    expect(view.code).toBe('PQ7K3M');
    expect(view.link).toBe('https://paintclash.example/?room=PQ7K3M');
  });

  it('carries the settings through untouched, so the form shows the truth', () => {
    const config = { mapSizeWU: 120, playerLimit: 4, botTarget: 2, lateJoin: false };
    expect(lobbyView(lobby({ config }), HERE).config).toEqual(config);
  });
});

describe('roomFormConfig (what the host typed, made legal)', () => {
  const room = { mapSizeWU: 140, playerLimit: 4, botTarget: 2, lateJoin: true };

  it('takes the typed numbers', () => {
    expect(
      roomFormConfig({ playerLimit: '6', mapSizeWU: '180', botTarget: '3', lateJoin: false }, room),
    ).toEqual({ playerLimit: 6, mapSizeWU: 180, botTarget: 3, lateJoin: false });
  });

  it('treats a CLEARED field as "unchanged", not as zero', () => {
    // `Number('')` is 0, and the policy would dutifully clamp that up to the
    // legal minimum — so an empty player field would read as "a room for two"
    // and an empty map field as the smallest arena there is. A host who cleared
    // a field to retype it said nothing yet.
    expect(
      roomFormConfig({ playerLimit: '', mapSizeWU: '', botTarget: '', lateJoin: true }, room),
    ).toEqual(room);
    // Blanks are per field: the one that WAS typed still counts.
    expect(
      roomFormConfig({ playerLimit: '8', mapSizeWU: '', botTarget: '', lateJoin: true }, room)
        .mapSizeWU,
    ).toBe(140);
  });

  it('still clamps whatever was typed into the room the server will build', () => {
    // The card must not promise a room the arena would refuse to be: the same
    // policy runs here and on the server (`sanitizeRoomConfig`), so the echo the
    // host sees back is the number they already saw.
    const asked = roomFormConfig(
      { playerLimit: '99', mapSizeWU: '99999', botTarget: '99', lateJoin: false },
      room,
    );
    expect(asked).toEqual({ playerLimit: 16, mapSizeWU: 400, botTarget: 16, lateJoin: false });
    // A bot count above the room's own limit cannot survive (spec §10.4).
    expect(
      roomFormConfig({ playerLimit: '4', mapSizeWU: '140', botTarget: '12', lateJoin: true }, room)
        .botTarget,
    ).toBe(4);
  });
});

describe('mapSizeAfterLimitChange', () => {
  it('follows the spec ladder while the host has not overridden it', () => {
    // Moving the limit from 8 to 2 should move the map with it — the default IS
    // per player count (spec §10.4), and a 200 WU field for two is a desert.
    expect(mapSizeAfterLimitChange(200, 8, 2)).toBe(100);
    expect(mapSizeAfterLimitChange(100, 2, 16)).toBe(280);
  });

  it('leaves a size the host chose alone', () => {
    // Spec §2.6 gives the size to the host. Silently re-deriving it would undo
    // their choice the next time they touched the player count.
    expect(mapSizeAfterLimitChange(120, 8, 2)).toBe(120);
    expect(mapSizeAfterLimitChange(BALANCE.room.mapSizeMinWU, 4, 8)).toBe(
      BALANCE.room.mapSizeMinWU,
    );
  });
});

describe('HostTokens', () => {
  /** A localStorage stand-in, as the other client stores are tested. */
  function fakeStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
    const map = new Map<string, string>();
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  it('remembers the secret for a room across a reload', () => {
    // A host who reloads must come back as the host — the token is the only
    // thing that says so, and it only ever existed in one POST response.
    const store = fakeStore();
    new HostTokens(store).remember('PQ7K3M', 'deadbeef');
    expect(new HostTokens(store).of('PQ7K3M')).toBe('deadbeef');
  });

  it('knows nothing about a room it did not create', () => {
    expect(new HostTokens(fakeStore()).of('PQ7K3M')).toBeNull();
  });

  it('keeps several rooms apart and forgets the oldest', () => {
    const tokens = new HostTokens(fakeStore());
    tokens.remember('AAAAAA', 'a');
    tokens.remember('BBBBBB', 'b');
    expect(tokens.of('AAAAAA')).toBe('a');
    expect(tokens.of('BBBBBB')).toBe('b');
    // Rooms are throwaway (spec §2.6): the store must not grow forever just
    // because someone likes creating them.
    for (let i = 0; i < 20; i++)
      tokens.remember(`ROOM${String(i).padStart(2, '0')}`, `t${String(i)}`);
    expect(tokens.of('AAAAAA')).toBeNull();
    expect(tokens.of('ROOM19')).toBe('t19');
  });

  it('degrades to session-only when storage is denied', () => {
    // Private mode / blocked storage: the host must still be able to host the
    // room they just created, they just lose it on reload.
    const tokens = new HostTokens(null);
    tokens.remember('PQ7K3M', 'deadbeef');
    expect(tokens.of('PQ7K3M')).toBe('deadbeef');
  });

  it('survives a corrupted envelope', () => {
    const store = fakeStore();
    store.setItem('paintclash.rooms.v1', '{not json');
    expect(new HostTokens(store).of('PQ7K3M')).toBeNull();
  });
});
