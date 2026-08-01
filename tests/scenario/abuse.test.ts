import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ARENA_CLOSE, LIMITS } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 15, spec §8.1–8.3): the resource caps that keep the one free
 * arena available, over the real stack — the real router, the real gate DO, a real
 * Arena-DO in workerd. Leitprinzip **Verfügbarkeit zuerst**: none of this is about
 * cheating (server authority settles that structurally, ADR-0003), all of it is
 * about what one hostile client can cost the arena.
 *
 * Four claims no single seam can show:
 *
 * 1. **A flood is dropped, then hung up on.** Frames beyond the per-connection
 *    budget cost nothing (they are never parsed), and a client that keeps it up
 *    loses the socket after a small tolerance window.
 * 2. **"Arena voll" is a clean refusal.** At the population limit the arena says
 *    so with a code the client can put on screen — no queue, no second arena.
 * 3. **One address cannot hold the arena.** The per-address socket cap refuses
 *    the surplus while the very same request from ANOTHER address gets in.
 * 4. **The join rate is charged in front of the arena.** Past the budget the
 *    router answers without ever waking a Durable Object.
 *
 * README rules apply. Two matter here in particular:
 *
 * - **Every socket comes from its own address**, except where an address is the
 *   subject of the test (claims 3 and 4 pin theirs deliberately, and claim 3
 *   proves a neighbour address stays untouched).
 * - **No wall-clock bets.** The flood is driven by frame COUNT, and the refusals
 *   are awaited as socket state, not slept for.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: () => string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await sleep(25);
  }
}

/** A fresh caller address per socket (README rule 6). */
let nextCaller = 0;
function freshCaller(): string {
  nextCaller += 1;
  return `198.51.100.${String(nextCaller % 250)}`;
}

interface Socket {
  ws: WebSocket;
  client: SimClient;
  /** How the server closed this socket, if it has (code + reason). */
  closed: { code: number; reason: string } | null;
}

/** Open one socket on the public arena from `ip`, as the browser client does. */
async function open(ip = freshCaller(), name = 'Flood'): Promise<Socket> {
  const response = await SELF.fetch('https://arena/ws', {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error(`server did not upgrade the connection (${String(response.status)})`);
  ws.accept();
  const socket: Socket = {
    ws,
    closed: null,
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
    if (typeof event.data !== 'string') socket.client.receive(event.data);
  });
  ws.addEventListener('close', (event) => {
    socket.closed = { code: event.code, reason: event.reason };
  });
  return socket;
}

/** Open, join and wait for the spawn — a socket that holds a slot for real. */
async function player(ip = freshCaller(), name = 'Spieler'): Promise<Socket> {
  const socket = await open(ip, name);
  socket.client.join();
  await until(
    () => socket.client.self() ?? socket.closed,
    () => `${name} to spawn or be refused`,
  );
  return socket;
}

function closeAll(sockets: readonly Socket[]): void {
  for (const socket of sockets) {
    try {
      socket.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/** The one public arena, at the fixed address the router uses (ADR-0004). */
const arenas = (env as { ARENA: DurableObjectNamespace }).ARENA;

/**
 * Hand the shared arena back the way this file found it (README rule 1).
 *
 * Every file in a run talks to the SAME public Arena-DO, and the pinned seed only
 * makes spawns reproducible if that object is *empty* when the next file arrives:
 * an emptied arena is rebuilt from the seed, a still-occupied one carries this
 * file's sockets — and the sixteen spawns it rolled — into the next
 * choreography, which then flies its heads through a world it did not expect.
 * This is the only file that fills the arena, so it is the one that has to prove
 * it left. Observed on the object itself rather than by connecting again: a probe
 * socket would roll a spawn of its own, which is the very thing being avoided.
 */
afterAll(async () => {
  const stub = arenas.get(arenas.idFromName('public'));
  const deadline = Date.now() + 5_000;
  let open = 0;
  for (;;) {
    open = await runInDurableObject(
      stub,
      (_instance: unknown, state: DurableObjectState) =>
        state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length,
    );
    if (open === 0 || Date.now() > deadline) break;
    await sleep(50);
  }
  expect(
    open,
    `the abuse choreographies left ${String(open)} sockets in the shared public arena — ` +
      `the next file's spawns would come from an arena this one had already advanced`,
  ).toBe(0);
  // One tick for the ticker to notice the emptiness and drop the world with it
  // (ADR-0004: live state is memory-only, an empty arena resets).
  await sleep(150);
});

describe('flood per connection (spec §8.3 point 2)', () => {
  it('drops the surplus unparsed and keeps the socket', async () => {
    const socket = await player(freshCaller(), 'Vielredner');
    try {
      const self = socket.client.self();
      expect(self, 'the flooder never spawned').not.toBeNull();
      // One window's worth plus a surplus. The frames are VALID joins — a
      // repeated join is a no-op the arena ignores, so what is being measured
      // here is purely the rate, never the content.
      for (let frame = 0; frame < LIMITS.framesPerWindow + 10; frame++) {
        socket.client.join();
      }
      // The arena keeps ticking for it: the surplus was dropped, not punished.
      const tick = socket.client.snapshot?.tick ?? 0;
      await until(
        () => (socket.client.snapshot?.tick ?? 0) > tick + 5 || socket.closed,
        () => 'the arena to keep ticking for a client that overshot once',
      );
      expect(socket.closed, 'one burst must not cost the socket').toBeNull();
    } finally {
      closeAll([socket]);
    }
  });

  it('hangs up on a client that keeps it up', async () => {
    const socket = await player(freshCaller(), 'Dauerflut');
    try {
      // `floodKillWindows` windows of flooding, driven by count and paced past
      // the window boundary — a flood is defined as "over the budget for
      // several windows in a row", so the pacing is the point, not a wait.
      for (let window = 0; window <= LIMITS.floodKillWindows; window++) {
        for (let frame = 0; frame < LIMITS.framesPerWindow + 5; frame++) {
          if (socket.closed) break;
          socket.client.join();
        }
        if (socket.closed) break;
        await sleep(LIMITS.frameWindowMs + 50);
      }
      const closed = await until(
        () => socket.closed,
        () => 'the arena to hang up on a sustained flood',
      );
      // 1008 (policy violation) rather than a 4xxx code: no player can act on
      // this, so it is not one of the refusals the client puts into words.
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('input flood');
    } finally {
      closeAll([socket]);
    }
  });

  it('hangs up on persistent garbage', async () => {
    // The other half of §8.3 point 2, over the real wire: frames that are not
    // the protocol at all. Dropped one by one, then the socket goes.
    const socket = await open(freshCaller(), 'Müll');
    try {
      for (let frame = 0; frame < LIMITS.garbageKillThreshold; frame++) {
        socket.ws.send(new Uint8Array([0xba, 0xad, 0xf0, 0x0d]));
      }
      const closed = await until(
        () => socket.closed,
        () => 'the arena to hang up on persistent garbage',
      );
      expect(closed.code).toBe(1008);
    } finally {
      closeAll([socket]);
    }
  });
});

describe('arena population limit (spec §8.3 point 4)', () => {
  it('refuses the player past the limit, cleanly and with a reason', async () => {
    const seated: Socket[] = [];
    try {
      // Fill the arena from `maxPlayers` different addresses, so nothing but the
      // population limit can be what refuses the next one.
      for (let slot = 0; slot < LIMITS.maxPlayers; slot++) {
        seated.push(await player(freshCaller(), `Spieler-${String(slot + 1)}`));
      }
      for (const [index, socket] of seated.entries()) {
        expect(socket.closed, `seated player ${String(index + 1)} was refused`).toBeNull();
      }
      const late = await open(freshCaller(), 'Zuspät');
      seated.push(late);
      const closed = await until(
        () => late.closed,
        () => 'the arena to refuse the player past its population limit',
      );
      // A code of its own, because the client turns it into words ("Die Arena
      // ist voll") — and no queue: the socket is closed, not parked.
      expect(closed.code).toBe(ARENA_CLOSE.full);
      expect(closed.reason).toBe('arena full');
      expect(late.client.self(), 'a refused socket must never get a world').toBeNull();
    } finally {
      closeAll(seated);
      // The arena drains and resets (ADR-0004) — the next file's choreography
      // must not inherit a full one.
      await sleep(200);
    }
  });
});

describe('per-address caps (spec §8.3 point 3)', () => {
  it('holds one address to its socket budget, distinctly from the arena being full', async () => {
    // At today's start value the two caps coincide (`maxConnectionsPerIp` ==
    // `maxPlayers`, see `limits.ts`), so one address CAN fill this arena. What
    // must still hold is that the two are different mechanisms with different
    // answers — the per-address one is what survives raising the population
    // limit, which ticket 02 expects after playtests.
    expect(LIMITS.maxConnectionsPerIp).toBeLessThanOrEqual(LIMITS.maxPlayers);
    const hoard = '203.0.113.42';
    const neighbourIp = '203.0.113.43';
    const sockets: Socket[] = [];
    try {
      for (let held = 0; held < LIMITS.maxConnectionsPerIp; held++) {
        const socket = await open(hoard, `Horter-${String(held + 1)}`);
        sockets.push(socket);
        expect(socket.closed, `socket ${String(held + 1)} of the budget was refused`).toBeNull();
      }
      const surplus = await open(hoard, 'Übertrieben');
      sockets.push(surplus);
      const refused = await until(
        () => surplus.closed,
        () => 'the arena to refuse a surplus socket from one address',
      );
      expect(refused.code).toBe(ARENA_CLOSE.tooManyConnections);

      // A neighbour address is refused too — but for the other reason, which is
      // the whole point: nothing about being next to a hoarder is held against
      // it, the arena is simply full.
      const turnedAway = await open(neighbourIp, 'Nachbar');
      sockets.push(turnedAway);
      const full = await until(
        () => turnedAway.closed,
        () => 'the full arena to refuse the neighbour',
      );
      expect(full.code).toBe(ARENA_CLOSE.full);

      // Proof that it really was fullness and not the address: free one of the
      // hoarder's sockets and the neighbour walks in. Retried rather than slept
      // for, because what has to happen first is a TICK (the arena removes a
      // departed player on its next one), not an amount of time.
      sockets[0]?.ws.close();
      let admitted: Socket | null = null;
      for (let attempt = 0; attempt < 20 && !admitted; attempt++) {
        const knock = await open(neighbourIp, 'Nachbar');
        sockets.push(knock);
        knock.client.join();
        await sleep(150);
        if (knock.client.self()) admitted = knock;
      }
      expect(admitted, 'a freed slot never admitted the neighbour address').not.toBeNull();
      expect(admitted?.closed).toBeNull();
    } finally {
      closeAll(sockets);
      await sleep(200);
    }
  });

  it('charges the join rate in front of the arena', async () => {
    // Every open counts, including the ones an arena refuses — reconnect spam
    // and room-code guessing are the same traffic (spec §8.3 point 3). The
    // budget is spent here from one pinned address, and the refusal comes from
    // the ROUTER: no upgrade at all, so no DO is ever woken.
    const spammer = '203.0.113.99';
    for (let attempt = 0; attempt < LIMITS.joinPerIp; attempt++) {
      const response = await SELF.fetch('https://arena/ws?room=PQ7K3M', {
        headers: { Upgrade: 'websocket', 'CF-Connecting-IP': spammer },
      });
      // A guessed code reaches its (empty) room DO and is refused there; what
      // matters is that the attempt was charged, which the next one shows.
      expect(response.status, `attempt ${String(attempt + 1)} was refused early`).toBe(101);
      // Accepted only to be closed: a socket the test never accepts cannot be
      // torn down from this side, and the room DO has already refused it anyway
      // (the code names no room) — the charge is what this test is about.
      response.webSocket?.accept();
      response.webSocket?.close();
    }
    const refused = await SELF.fetch('https://arena/ws?room=PQ7K3M', {
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': spammer },
    });
    expect(refused.status).toBe(429);
    expect(refused.webSocket, 'a refused open must not upgrade').toBeNull();
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Another address is unaffected — the budget is per address, not global.
    const other = await SELF.fetch('https://arena/ws', {
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.100' },
    });
    expect(other.status).toBe(101);
    other.webSocket?.accept();
    other.webSocket?.close();
    // Drain: the public arena is shared by every file in this run (ADR-0004,
    // one DO), and it resets itself once the last socket is gone.
    await sleep(200);
  });
});
