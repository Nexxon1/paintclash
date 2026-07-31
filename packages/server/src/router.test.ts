import { BALANCE, defaultRoomConfig, normalizeRoomCode } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import {
  arenaSeedOverride,
  arenaSizeOverride,
  botTargetOverride,
  defaultBotTarget,
  freshHostToken,
  freshRoomCode,
  handleFetch,
  healthPayload,
  ROOM_CODE_ATTEMPTS,
  type Env,
} from './router.js';

/** One room-DO stand-in: records what it was asked to create and answers with `status`. */
interface FakeRoom {
  name: string;
  body: unknown;
}

interface FakeEnv extends Env {
  /** Requests forwarded to an Arena-DO as a WebSocket upgrade. */
  forwarded: { name: string; request: Request }[];
  /** `POST /room` calls, i.e. room creations that reached a DO. */
  created: FakeRoom[];
  /** Addresses the gate was asked about. */
  charged: string[];
}

interface FakeOptions {
  /** Status the room DO answers `POST /room` with, per attempt. */
  createStatus?: number[];
  /** Seconds the gate refuses with; undefined = it allows. */
  refuseFor?: number;
}

function fakeEnv(options: FakeOptions = {}, overrides: Partial<Env> = {}): FakeEnv {
  const forwarded: { name: string; request: Request }[] = [];
  const created: FakeRoom[] = [];
  const charged: string[] = [];
  const arena = {
    idFromName: (name: string) => name,
    get: (name: unknown) => ({
      fetch: (request: Request | string, init?: RequestInit) => {
        if (typeof request === 'string') {
          const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
          created.push({ name: String(name), body });
          return Promise.resolve(
            new Response(null, { status: options.createStatus?.[created.length - 1] ?? 201 }),
          );
        }
        // Node cannot build a real 101 Response — the marker body suffices.
        forwarded.push({ name: String(name), request });
        return Promise.resolve(new Response('upgraded'));
      },
    }),
  } as unknown as Env['ARENA'];
  const gate = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (url: string) => {
        charged.push(new URL(url).searchParams.get('ip') ?? '');
        return Promise.resolve(
          options.refuseFor === undefined
            ? new Response(null, { status: 200 })
            : new Response(null, {
                status: 429,
                headers: { 'Retry-After': String(options.refuseFor) },
              }),
        );
      },
    }),
  } as unknown as Env['ROOM_GATE'];
  return {
    ASSETS: { fetch: () => Promise.resolve(new Response('asset', { status: 200 })) },
    COMMIT_SHA: 'abc123',
    ARENA: arena,
    ROOM_GATE: gate,
    forwarded,
    created,
    charged,
    ...overrides,
  };
}

function upgrade(url: string): Request {
  return new Request(url, { headers: { Upgrade: 'websocket' } });
}

function createRequest(body?: unknown): Request {
  return new Request('https://paintclash.test/api/rooms', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.7' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('router worker (ADR-0004: stateless, routes WS to the arena DO)', () => {
  it('answers the health probe with the deployed commit', async () => {
    const env = fakeEnv();
    const response = await handleFetch(new Request('https://x/api/health'), env);
    expect(await response.json()).toEqual(healthPayload('abc123'));
  });

  it('forwards /ws to the one public arena DO', async () => {
    const env = fakeEnv();
    const response = await handleFetch(upgrade('https://x/ws'), env);
    expect(await response.text()).toBe('upgraded');
    expect(env.forwarded.map((entry) => entry.name)).toEqual(['public']);
  });

  it('serves everything else from static assets', async () => {
    const env = fakeEnv();
    const response = await handleFetch(new Request('https://x/index.html'), env);
    expect(await response.text()).toBe('asset');
    expect(env.forwarded).toHaveLength(0);
  });
});

describe('private-room routing (ticket 14, ADR-0004: 1 DO per room code)', () => {
  it('addresses the room DO by the NORMALIZED code', async () => {
    const env = fakeEnv();
    // Typed in lowercase with a dash — the same string must reach `idFromName`
    // as the one the create endpoint handed out, or the player lands in an
    // empty room that shares nothing but a spelling.
    await handleFetch(upgrade('https://x/ws?room=pq7-k3m'), env);
    expect(env.forwarded.map((entry) => entry.name)).toEqual(['PQ7K3M']);
  });

  it('never confuses a room code with the public arena', () => {
    // The public arena's DO name is lowercase and room codes are uppercase, which
    // is the whole reason a code can be used as a DO name verbatim.
    expect(normalizeRoomCode('public')).toBeNull();
  });

  it('refuses a code that is not one, without touching a DO', async () => {
    const env = fakeEnv();
    const response = await handleFetch(upgrade('https://x/ws?room=nope'), env);
    expect(response.status).toBe(400);
    expect(env.forwarded).toHaveLength(0);
  });
});

describe('room creation (spec §2.6/§8.3 point 6)', () => {
  it('charges the caller address, writes the room and returns the link', async () => {
    const env = fakeEnv();
    const response = await handleFetch(createRequest(), env);
    expect(response.status).toBe(200);
    const body: { code: string; hostToken: string; url: string } = await response.json();
    expect(env.charged).toEqual(['203.0.113.7']);
    // The code is a real one, the DO it was written to is named by it, and the
    // link is the code on the origin the request came in on.
    expect(normalizeRoomCode(body.code)).toBe(body.code);
    expect(env.created).toHaveLength(1);
    expect(env.created[0]?.name).toBe(body.code);
    expect(body.url).toBe(`https://paintclash.test/?room=${body.code}`);
    expect(body.hostToken).toMatch(/^[0-9a-f]{32}$/);
    // The room is created with the spec's defaults and the host's own secret.
    expect(env.created[0]?.body).toEqual({
      code: body.code,
      config: defaultRoomConfig(),
      hostToken: body.hostToken,
    });
  });

  it('takes the settings the host asked for, made legal', async () => {
    const env = fakeEnv();
    await handleFetch(createRequest({ playerLimit: 99, botTarget: 3, lateJoin: false }), env);
    expect(env.created[0]?.body).toMatchObject({
      config: {
        playerLimit: BALANCE.room.playerLimitMax,
        botTarget: 3,
        lateJoin: false,
        mapSizeWU: 280,
      },
    });
  });

  it('survives a request without a body', async () => {
    // The client posts nothing when it just wants a room; a malformed body is
    // the same wish, not an error.
    const env = fakeEnv();
    const response = await handleFetch(createRequest(), env);
    expect(response.status).toBe(200);
    expect(env.created[0]?.body).toMatchObject({ config: defaultRoomConfig() });
  });

  it('draws a new code when the first already names a live room', async () => {
    // 409 from the room DO is the collision check that makes ~10⁹ combinations
    // safe to use as addresses: a collision costs one extra draw, never a
    // player dropped into strangers' room.
    const env = fakeEnv({ createStatus: [409, 409, 201] });
    const response = await handleFetch(createRequest(), env);
    expect(response.status).toBe(200);
    expect(env.created).toHaveLength(3);
    const names = env.created.map((room) => room.name);
    expect(new Set(names).size).toBe(3);
    const body: { code: string } = await response.json();
    expect(body.code).toBe(names[2]);
  });

  it('gives up rather than looping forever on collisions', async () => {
    const env = fakeEnv({ createStatus: Array.from({ length: 9 }, () => 409) });
    const response = await handleFetch(createRequest(), env);
    expect(response.status).toBe(503);
    expect(env.created).toHaveLength(ROOM_CODE_ATTEMPTS);
  });

  it('reports a room DO that failed for any other reason', async () => {
    const env = fakeEnv({ createStatus: [500] });
    expect((await handleFetch(createRequest(), env)).status).toBe(502);
  });

  it('passes the rate limit through with its Retry-After', async () => {
    const env = fakeEnv({ refuseFor: 42 });
    const response = await handleFetch(createRequest(), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    // Refused before anything was created: the point of the limit is that a
    // refused caller costs no DO and no SQLite write.
    expect(env.created).toHaveLength(0);
  });

  it('still charges a request without CF-Connecting-IP', async () => {
    // Everything anonymous shares one bucket — the safe direction. Skipping the
    // budget would make the header the way around it.
    const env = fakeEnv();
    await handleFetch(new Request('https://x/api/rooms', { method: 'POST', body: '{}' }), env);
    expect(env.charged).toEqual(['unknown']);
  });

  it('answers anything but POST on the rooms endpoint with 405', async () => {
    const env = fakeEnv();
    expect((await handleFetch(new Request('https://x/api/rooms'), env)).status).toBe(405);
    expect(env.charged).toHaveLength(0);
  });
});

describe('room code and host token generation', () => {
  it('produces codes the router can route by', () => {
    for (let draw = 0; draw < 50; draw++) {
      const code = freshRoomCode();
      expect(normalizeRoomCode(code)).toBe(code);
    }
  });

  it('throws rather than degrading when the randomness is broken', () => {
    // Unreachable with a working CSPRNG, and deliberately loud: a generator
    // that quietly returned something predictable would hand out guessable
    // rooms, which is the one property this code has.
    expect(() => freshRoomCode((size) => new Uint8Array(size).fill(0xff))).toThrow(/entropy/);
  });

  it('mints a 128-bit host token', () => {
    expect(freshHostToken((size) => new Uint8Array(size).fill(0x0a))).toBe('0a'.repeat(16));
    expect(freshHostToken()).toMatch(/^[0-9a-f]{32}$/);
    expect(freshHostToken()).not.toBe(freshHostToken());
  });
});

describe('dev-only env overrides', () => {
  it('takes a playable arena size and refuses anything else', () => {
    expect(arenaSizeOverride('50')).toBe(50);
    expect(arenaSizeOverride(undefined)).toBeUndefined();
    // An operator typo must fall back to the BALANCE default, never produce a
    // 1-WU or NaN-sized arena.
    for (const raw of ['', 'fifty', '9', '1001', 'NaN', 'Infinity', '-50']) {
      expect(arenaSizeOverride(raw)).toBeUndefined();
    }
  });

  it('takes a uint32 arena seed and refuses anything else', () => {
    // A pinned seed is what makes scenario spawns reproducible (§9.1) — so a
    // typo must degrade to "random", not to a seed of 0 by accident.
    expect(arenaSeedOverride('20260730')).toBe(20_260_730);
    expect(arenaSeedOverride('0')).toBe(0);
    expect(arenaSeedOverride(undefined)).toBeUndefined();
    for (const raw of ['', 'seed', '1.5', '-1', '4294967296', 'NaN', 'Infinity']) {
      expect(arenaSeedOverride(raw)).toBeUndefined();
    }
  });

  it('sizes the DEFAULT bot target to the arena, never above the balanced one', () => {
    // The spec's own room-sizing ladder (§10.4) read backwards: ~5000 WU² per
    // entity. The public arena lands on exactly the balanced target.
    expect(defaultBotTarget(BALANCE.arena.sizeWU)).toBe(BALANCE.bots.targetPopulation);
    expect(defaultBotTarget(100)).toBe(2); // the spec's 2-player map
    expect(defaultBotTarget(140)).toBe(3); // the spec's 4-player map
    // A map too small for even one entity's worth of room gets none. Eight bots
    // in a 50 WU arena is 16× the density the spec sizes for; it saturated and
    // blew the tick budget within 30 s of play.
    expect(defaultBotTarget(50)).toBe(0);
    // Never ABOVE the balanced target, however much room there is — the ceiling
    // is a gameplay decision, not an area one.
    expect(defaultBotTarget(1000)).toBe(BALANCE.bots.targetPopulation);
  });

  it('takes a bot target within the population rule and refuses anything else', () => {
    // 0 is a MEANING, not a typo: it switches the population off, which is how
    // the scenario choreographies stay hermetic.
    expect(botTargetOverride('0')).toBe(0);
    expect(botTargetOverride('4')).toBe(4);
    expect(botTargetOverride(undefined)).toBeUndefined();
    // Above the ceiling is a mis-set var, not a wish: falling back to the
    // BALANCE target is the only safe reading — an arena must never be flooded
    // by a stray environment variable.
    for (const raw of ['', ' ', 'eight', '2.5', '-1', 'NaN', 'Infinity', '999']) {
      expect(botTargetOverride(raw)).toBeUndefined();
    }
  });
});
