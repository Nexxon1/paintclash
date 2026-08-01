import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { BALANCE, LIMITS, ROOM_CLOSE, normalizeRoomCode } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 14, spec §2.6): private rooms over the real stack — the real
 * router, a real room Durable Object in workerd, headless sim-clients on the real
 * binary protocol. What is checked here is what no single seam can show:
 *
 * 1. **A code is an address.** `POST /api/rooms` hands out a code, and a socket
 *    carrying it reaches THAT room — an empty lobby, not the public arena.
 * 2. **The lobby is a phase.** Members wait and see each other; only the host's
 *    start turns them into players (spec §2.6: Host-Start).
 * 3. **The host's settings are the arena's.** The map the players spawn on is the
 *    one the lobby last showed, and bots appear only if the host asked.
 * 4. **The door is the host's to close.** Late join lets a shared link work
 *    mid-game; switched off, the room refuses with a reason the client can read.
 * 5. **The room ends.** Empty plus the grace period frees the code again.
 *
 * The public arena is untouched by all of it, which the last test asserts.
 *
 * README rules apply. Two are worth spelling out here:
 *
 * - **Every creation and every socket comes from its own address.** Both are
 *   rate-limited per IP (spec §8.3 point 6 and, since ticket 15, point 3) and
 *   this file creates and joins far more rooms than one address may — sharing one
 *   would make the sixth test fail for a reason that has nothing to do with what
 *   it tests.
 * - **The grace period is fired, not waited out.** It is 90 s of wall clock; the
 *   test drives the room's alarm directly, so it tests the rule instead of the
 *   runner's patience.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: () => string,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await sleep(25);
  }
}

/**
 * The scenario worker's bindings. `ProvidedEnv` is an empty interface unless a
 * project augments it, so the two namespaces this file reaches for are named
 * here rather than everywhere they are used.
 */
const bindings = env as { ARENA: DurableObjectNamespace };

/** The room DO for a code — the same address the router uses (ADR-0004). */
function roomStub(code: string): DurableObjectStub {
  return bindings.ARENA.get(bindings.ARENA.idFromName(code));
}

/** A fresh caller address per creation and per socket — see the header note. */
let nextCaller = 0;
function freshCaller(): string {
  nextCaller += 1;
  return `10.0.${String(Math.floor(nextCaller / 250))}.${String(nextCaller % 250)}`;
}

interface Created {
  code: string;
  hostToken: string;
  url: string;
}

/** `POST /api/rooms` through the real router, from a given address. */
function createRoom(wish: Record<string, unknown> = {}, ip = freshCaller()): Promise<Response> {
  return SELF.fetch('https://arena/api/rooms', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: JSON.stringify(wish),
  });
}

async function createdRoom(wish: Record<string, unknown> = {}): Promise<Created> {
  const response = await createRoom(wish);
  expect(
    response.status,
    'the room endpoint refused a creation — is this call sharing a caller address?',
  ).toBe(200);
  return (await response.json()) as Created;
}

interface Member {
  client: SimClient;
  ws: WebSocket;
  /** The close the room answered with, if it refused (code + reason). */
  refusal: { code: number; reason: string } | null;
}

/** Open a socket into a room and send the join wish, as the browser client does. */
async function joinRoom(code: string, name: string, hostToken?: string): Promise<Member> {
  const search = new URLSearchParams({ room: code });
  if (hostToken !== undefined) search.set('host', hostToken);
  const response = await SELF.fetch(`https://arena/ws?${search.toString()}`, {
    // Its own address, like every creation: socket opens are rate-limited per
    // address too (spec §8.3 point 3, ticket 15), and this file opens far more
    // sockets than one address may in a minute.
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': freshCaller() },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error('server did not upgrade the connection');
  ws.accept();
  const member: Member = {
    ws,
    refusal: null,
    client: new SimClient((frame) => {
      try {
        ws.send(frame);
      } catch {
        // Socket torn down while a queued frame was flushing (see the other
        // scenario files): swallowing it keeps the DO's event loop clean.
      }
    }, name),
  };
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') member.client.receive(event.data);
  });
  ws.addEventListener('close', (event) => {
    member.refusal = { code: event.code, reason: event.reason };
  });
  member.client.join();
  return member;
}

/**
 * Run the room's grace alarm now, waiting for it to be armed first. A room that
 * never armed one would never close — so that premise names itself rather than
 * showing up as a room that mysteriously still exists.
 */
async function fireGrace(code: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await runDurableObjectAlarm(roomStub(code))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `no grace alarm was armed for room ${code} — an emptied room would ` +
          `never close and its code would never come free (spec §2.6)`,
      );
    }
    await sleep(25);
  }
}

describe('room creation (spec §2.6: code + shareable link, not listed)', () => {
  it('hands out a code, a host secret and a link', async () => {
    const room = await createdRoom();
    // The code is one the router can route by — the same rule the client
    // pre-checks with, so a link it produces can always be followed.
    expect(normalizeRoomCode(room.code)).toBe(room.code);
    expect(room.url).toBe(`https://arena/?room=${room.code}`);
    expect(room.hostToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives every room its own code and its own secret', async () => {
    const rooms = [await createdRoom(), await createdRoom(), await createdRoom()];
    expect(new Set(rooms.map((room) => room.code)).size).toBe(3);
    expect(new Set(rooms.map((room) => room.hostToken)).size).toBe(3);
  });

  it('rate-limits creation per address (spec §8.3 point 6)', async () => {
    // Every room is a DO plus a SQLite write, so this is the one call that costs
    // something before anyone has played a tick. A DIFFERENT address stays
    // unaffected — otherwise the limit would be a global outage switch.
    const ip = '198.51.100.42';
    for (let i = 0; i < LIMITS.roomCreatePerIp; i++) {
      expect((await createRoom({}, ip)).status, `creation ${String(i + 1)} of the budget`).toBe(
        200,
      );
    }
    const refused = await createRoom({}, ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await createRoom({}, '198.51.100.43')).status).toBe(200);
  });

  it('refuses a code that could not be one, before any DO is touched', async () => {
    const response = await SELF.fetch('https://arena/ws?room=nope', {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(400);
  });

  it('closes a socket for a code that names no room', async () => {
    // Never created, or long closed: either way the player has to be told, and a
    // close code is the only channel a refused WebSocket has.
    const member = await joinRoom('ZZZZZZ', 'Verirrt');
    const refusal = await until(
      () => member.refusal,
      () => 'the room to refuse an unknown code',
    );
    expect(refusal.code).toBe(ROOM_CLOSE.unknown);
  });
});

describe('lobby and host start (spec §2.6)', () => {
  it('members wait in the lobby and see each other', async () => {
    const room = await createdRoom({ playerLimit: 4 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    const lobby = await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    expect(lobby.code).toBe(room.code);
    // Waiting, not playing: a lobby member has no player id yet, which is what
    // makes "the host has not started" observable at all.
    expect(host.client.playerId).toBeNull();
    expect(lobby.members).toEqual([{ playerId: 1, name: 'Ada', host: true }]);
    expect(lobby.config.playerLimit).toBe(4);
    // The default map for four players, straight off the spec §10.4 ladder.
    expect(lobby.config.mapSizeWU).toBe(140);

    const guest = await joinRoom(room.code, 'Grace');
    const seen = await until(
      () => (host.client.lobby?.members.length === 2 ? host.client.lobby : null),
      () => `the host to see 2 members (saw ${String(host.client.lobby?.members.length)})`,
    );
    expect(seen.members.map((member) => member.name)).toEqual(['Ada', 'Grace']);
    expect(seen.members.map((member) => member.host)).toEqual([true, false]);
    const guestLobby = await until(
      () => (guest.client.lobby?.members.length === 2 ? guest.client.lobby : null),
      () => 'the guest to see both members',
    );
    // Each recipient is told which row is theirs — names are not unique, so
    // nothing else in the frame could say it.
    expect(guestLobby.selfId).toBe(2);
    expect(seen.selfId).toBe(1);
    host.ws.close();
    guest.ws.close();
  });

  it('only the HOST can change the settings and start', async () => {
    const room = await createdRoom({ playerLimit: 4 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    const guest = await joinRoom(room.code, 'Grace');
    const guestLobby = await until(
      () => guest.client.lobby,
      () => 'the guest to reach the lobby',
    );

    // A member asking for a bigger room is ignored — silently, because it is a
    // manipulated client at worst and cannot express anything else here.
    guest.client.setRoomConfig({ ...guestLobby.config, playerLimit: 16 });
    guest.client.startRoom();
    await sleep(400);
    expect(guest.client.lobby?.config.playerLimit, 'a member changed the room').toBe(4);
    expect(guest.client.playerId, 'a member started the game').toBeNull();

    // The host's word stands, and every member sees it.
    host.client.setRoomConfig({ ...guestLobby.config, mapSizeWU: 80 });
    const changed = await until(
      () => (guest.client.lobby?.config.mapSizeWU === 80 ? guest.client.lobby : null),
      () =>
        `the guest to see the new map size (saw ${String(guest.client.lobby?.config.mapSizeWU)})`,
    );
    expect(changed.config.mapSizeWU).toBe(80);
    host.ws.close();
    guest.ws.close();
  });

  it("the start turns every waiting member into a player on the host's map", async () => {
    const room = await createdRoom({ playerLimit: 4, mapSizeWU: 90 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    const guest = await joinRoom(room.code, 'Grace');
    await until(
      () => guest.client.lobby,
      () => 'the guest to reach the lobby',
    );

    host.client.startRoom();
    // The welcome IS the start: both get a player id and the host's arena size.
    await until(
      () => host.client.self(),
      () => 'the host to spawn after the start',
    );
    await until(
      () => guest.client.self(),
      () => 'the guest to spawn after the start',
    );
    expect(host.client.arenaSizeWU).toBe(90);
    expect(guest.client.arenaSizeWU).toBe(90);
    // Two different players in ONE arena — each sees both heads.
    expect(host.client.playerId).not.toBe(guest.client.playerId);
    const snapshot = await until(
      () => (host.client.snapshot?.players.length === 2 ? host.client.snapshot : null),
      () => `both heads in one snapshot (saw ${String(host.client.snapshot?.players.length)})`,
    );
    expect(snapshot.players).toHaveLength(2);
    // Bots stay off unless the host asks for them (spec §10.4), so the room
    // holds exactly the two people in it.
    await sleep(600);
    expect(host.client.snapshot?.players.length, 'a bot appeared in a bots-off room').toBe(2);
    // A running room is a normal arena in every other respect.
    expect(host.client.leaderboard.length).toBeGreaterThan(0);
    host.ws.close();
    guest.ws.close();
  });

  it('hands the host role on when the host leaves the lobby', async () => {
    // Without this, a host who closed their tab would leave a lobby nobody can
    // ever start — a room that exists only to be waited in.
    const room = await createdRoom({ playerLimit: 4 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    const heir = await joinRoom(room.code, 'Grace');
    await until(
      () => heir.client.lobby?.members.length === 2,
      () => 'the heir to see both members',
    );
    expect(heir.client.lobby?.members.find((member) => member.name === 'Grace')?.host).toBe(false);

    host.ws.close();
    await until(
      () => heir.client.lobby?.members.find((member) => member.name === 'Grace')?.host === true,
      () => 'the remaining member to become host after the host left',
    );
    // And the new host can actually start — the role is real, not a badge.
    heir.client.startRoom();
    await until(
      () => heir.client.self(),
      () => 'the promoted host to start the game',
    );
    heir.ws.close();
  });
});

describe('room limits and late join (spec §2.6)', () => {
  it("refuses a socket beyond the host's player limit", async () => {
    const room = await createdRoom({ playerLimit: 2 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    const second = await joinRoom(room.code, 'Grace');
    await until(
      () => second.client.lobby,
      () => 'the second member to reach the lobby',
    );

    const third = await joinRoom(room.code, 'Edsger');
    const refusal = await until(
      () => third.refusal,
      () => 'the third socket to be refused by a two-player room',
    );
    expect(refusal.code).toBe(ROOM_CLOSE.full);
    // The room itself is untouched by the refusal.
    expect(host.client.lobby?.members).toHaveLength(2);
    host.ws.close();
    second.ws.close();
  });

  it('never lowers the limit below the people already waiting', async () => {
    // The limit is an admission rule (spec §2.6). Without a floor at the current
    // occupancy, a host lowering it would have the members who arrived FIRST
    // closed with "room full" — at the start, minutes after they joined.
    const room = await createdRoom({ playerLimit: 4 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    const lobby = await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    const second = await joinRoom(room.code, 'Grace');
    const third = await joinRoom(room.code, 'Edsger');
    await until(
      () => host.client.lobby?.members.length === 3,
      () => `the host to see 3 members (saw ${String(host.client.lobby?.members.length)})`,
    );

    host.client.setRoomConfig({ ...lobby.config, playerLimit: 2 });
    await sleep(400);
    expect(host.client.lobby?.config.playerLimit).toBe(3);

    // …and the start really does keep all three.
    host.client.startRoom();
    for (const [who, member] of [
      ['the host', host],
      ['the second member', second],
      ['the third member', third],
    ] as const) {
      await until(
        () => member.client.self(),
        () => `${who} to spawn — a lowered limit dropped someone who was already in`,
      );
      expect(member.refusal, `${who} was closed by the room`).toBeNull();
    }
    host.ws.close();
    second.ws.close();
    third.ws.close();
  });

  it('lets a shared link work mid-game while late join is on (drop-in)', async () => {
    const room = await createdRoom({ playerLimit: 4, mapSizeWU: 90, lateJoin: true });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    host.client.startRoom();
    await until(
      () => host.client.self(),
      () => 'the host to spawn',
    );

    // No lobby for a late joiner — the game is running, so it is welcomed
    // straight into it.
    const late = await joinRoom(room.code, 'Grace');
    await until(
      () => late.client.self(),
      () => 'the late joiner to spawn into the running game',
    );
    expect(late.client.lobby, 'a running room showed a lobby').toBeNull();
    expect(late.client.arenaSizeWU).toBe(90);
    await until(
      () => host.client.snapshot?.players.length === 2,
      () => `the host to see the late joiner (saw ${String(host.client.snapshot?.players.length)})`,
    );
    host.ws.close();
    late.ws.close();
  });

  it('closes the door when the host switched late join off', async () => {
    const room = await createdRoom({ playerLimit: 4, mapSizeWU: 90, lateJoin: false });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    const lobby = await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    expect(lobby.config.lateJoin).toBe(false);
    host.client.startRoom();
    await until(
      () => host.client.self(),
      () => 'the host to spawn',
    );

    const late = await joinRoom(room.code, 'Grace');
    const refusal = await until(
      () => late.refusal,
      () => 'the late socket to be refused by a closed game',
    );
    expect(refusal.code).toBe(ROOM_CLOSE.running);
    host.ws.close();
  });

  it('fills a room with bots when the host asks for them (spec §10.4)', async () => {
    // Off by default (asserted above); this is the toggle. The host's number is
    // the target population the clamp rule fills toward:
    // `bots = clamp(target − humans, 0, maxBots)` ⇒ 3 − 1 = 2 bots + 1 human.
    const room = await createdRoom({ playerLimit: 4, mapSizeWU: 140, botTarget: 3 });
    const host = await joinRoom(room.code, 'Ada', room.hostToken);
    const lobby = await until(
      () => host.client.lobby,
      () => 'the host to reach the lobby',
    );
    expect(lobby.config.botTarget).toBe(3);
    host.client.startRoom();
    await until(
      () => host.client.self(),
      () => 'the host to spawn',
    );
    const populated = await until(
      () => (host.client.snapshot?.players.length === 3 ? host.client.snapshot : null),
      () =>
        `the room to fill to 3 entities (saw ${String(host.client.snapshot?.players.length)}) — ` +
        `the host's bot target must reach ArenaCore verbatim, NOT through the ` +
        `area-sized default the public arena uses`,
    );
    expect(populated.players).toHaveLength(3);
    host.ws.close();
  });
});

describe('room lifecycle (spec §2.6: an empty room closes after the grace period)', () => {
  it('frees the code once the grace period expires on an empty room', async () => {
    const room = await createdRoom({ playerLimit: 2 });
    const member = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => member.client.lobby,
      () => 'the member to reach the lobby',
    );
    member.ws.close();
    await fireGrace(room.code);

    // The record is gone, so the code names no room any more — which is exactly
    // what "der Code ist danach frei" means (ADR-0004: the record IS the room).
    const returning = await joinRoom(room.code, 'Ada');
    const refusal = await until(
      () => returning.refusal,
      () => 'the closed room to refuse a returning player',
    );
    expect(refusal.code).toBe(ROOM_CLOSE.unknown);
  });

  it('closes a room nobody ever joined', async () => {
    // A room is born empty, so the grace period has to be armed at creation —
    // otherwise a mistyped invitation would leave a code taken forever.
    const room = await createdRoom();
    await fireGrace(room.code);
    const late = await joinRoom(room.code, 'Ada', room.hostToken);
    const refusal = await until(
      () => late.refusal,
      () => 'the never-used room to have closed itself',
    );
    expect(refusal.code).toBe(ROOM_CLOSE.unknown);
  });

  it('keeps a room that was reoccupied inside its grace period', async () => {
    // The grace exists to cover short disconnects: a reload must not cost the
    // room, and an alarm that fires afterwards must notice someone is back.
    const room = await createdRoom({ playerLimit: 2 });
    const first = await joinRoom(room.code, 'Ada', room.hostToken);
    await until(
      () => first.client.lobby,
      () => 'the member to reach the lobby',
    );
    first.ws.close();
    const back = await joinRoom(room.code, 'Ada', room.hostToken);
    const lobby = await until(
      () => back.client.lobby,
      () => 'the reload to land back in the lobby',
    );
    // Whether an alarm is still armed is a race with the reconnect; either way
    // the room must survive it.
    await runDurableObjectAlarm(roomStub(room.code));
    await sleep(200);
    expect(back.refusal).toBeNull();
    // …and the token holder is the host again, not a guest in their own room.
    expect(lobby.members.some((member) => member.host)).toBe(true);
    back.ws.close();
  });
});

describe('the public arena is untouched (ADR-0004)', () => {
  it('a plain /ws still joins the one public arena and plays immediately', async () => {
    const response = await SELF.fetch('https://arena/ws', { headers: { Upgrade: 'websocket' } });
    const ws = response.webSocket;
    if (!ws) throw new Error('server did not upgrade the connection');
    ws.accept();
    const client = new SimClient((frame) => {
      try {
        ws.send(frame);
      } catch {
        /* torn down mid-flush */
      }
    }, 'Publikum');
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') client.receive(event.data);
    });
    client.join();
    await until(
      () => client.self(),
      () => 'the public arena to spawn a player',
    );
    // No lobby, no host, and the BALANCE arena size — the public path never
    // learned about rooms.
    expect(client.lobby).toBeNull();
    expect(client.arenaSizeWU).toBe(BALANCE.arena.sizeWU);
    ws.close();
  });
});
