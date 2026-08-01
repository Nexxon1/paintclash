/**
 * Router-Worker (spec §5.2, ADR-0004): stateless entry — serves the static
 * client via Workers Static Assets, answers the health probe, creates private
 * rooms and routes WebSocket connections to the right Arena-DO (public → the one
 * fixed address, private → the room code). Seam for the later matchmaker. Kept
 * free of `cloudflare:workers` imports so it stays unit-testable in plain node.
 */

import {
  BALANCE,
  normalizeRoomCode,
  roomCodeFrom,
  roomShareLink,
  sanitizeRoomConfig,
} from '@paintclash/shared';

import type { GateBucket } from './room-gate.js';

/** Bindings declared in `wrangler.jsonc`. */
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly COMMIT_SHA: string;
  readonly ARENA: DurableObjectNamespace;
  /**
   * The per-IP budgets (spec §8.3 point 3 + 6): room creations and socket opens
   * — one object at a fixed address, see `room-gate-do.ts`.
   */
  readonly ROOM_GATE: DurableObjectNamespace;
  /**
   * Dev-only arena-size override in WU (`wrangler dev --var ARENA_SIZE_WU:50`)
   * — a small field makes death/fill mechanics testable in seconds. Never set
   * on deploys: production always plays BALANCE.arena.sizeWU.
   */
  readonly ARENA_SIZE_WU?: string;
  /**
   * Dev/test-only RNG seed for a fresh arena. Set it and the spawns are FIXED:
   * the same run produces the same start blocks and headings every time, which
   * is what turns a scenario choreography from a probabilistic maneuver into a
   * reproducible one (see `tests/scenario/wrangler.jsonc`). Never set on
   * deploys — production seeds itself from `crypto`.
   */
  readonly ARENA_SEED?: string;
  /**
   * Dev/test-only override of the arena's bot target population (spec §2.7).
   * Unset means the public arena's balanced target; `0` switches bots off,
   * which is what keeps the scenario choreographies hermetic
   * (`tests/scenario/wrangler.jsonc`).
   */
  readonly ARENA_BOTS?: string;
}

/**
 * Parse the dev-only ARENA_SIZE_WU override (see `Env`). Anything outside a
 * sane playable band falls back to the BALANCE default — an operator typo must
 * not produce a 1-WU or NaN-sized arena.
 */
export function arenaSizeOverride(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const size = Number(raw);
  return Number.isFinite(size) && size >= 10 && size <= 1000 ? size : undefined;
}

/**
 * Parse the dev/test-only ARENA_SEED override (see `Env`). The sim's RNG is a
 * uint32-seeded PRNG (`sim-core/rng.ts`), so anything that is not a whole
 * number in that range is a typo and falls back to a random seed.
 */
export function arenaSeedOverride(raw: string | undefined): number | undefined {
  // `Number('')` is 0, and 0 is a perfectly valid seed — an empty or blank var
  // would otherwise pin every arena to the same world by accident.
  if (raw === undefined || raw.trim() === '') return undefined;
  const seed = Number(raw);
  return Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff ? seed : undefined;
}

/**
 * Parse the dev/test-only ARENA_BOTS override (see `Env`). A target above the
 * ceiling of the population rule (`BALANCE.bots.maxBots` bots on top of the
 * humans present) is a mis-set variable rather than a wish, and falls back to
 * the balanced target — no environment typo may flood an arena. `0` is a
 * meaning, not a typo: it switches the population off.
 */
export function botTargetOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const target = Number(raw);
  return Number.isInteger(target) && target >= 0 && target <= BALANCE.bots.maxBots
    ? target
    : undefined;
}

/**
 * How many entities to keep an arena of this size populated to, when nobody said
 * otherwise. The spec's own room-sizing rule read backwards (§10.4:
 * `edge = √(players × 5000)`, so ~`areaPerEntityWU2` per entity), capped by the
 * balanced target — the 200 WU public arena lands on exactly that target, while
 * a small dev or private map gets proportionally fewer.
 *
 * It exists because a flat target does not survive a small map: fill cost grows
 * with how interlocked territories are, and eight bots in a 50 WU arena (16× the
 * density the spec sizes for) saturated it and blew the 50 ms tick budget inside
 * 30 s — a freeze. This is only the DEFAULT: an explicit `ARENA_BOTS`, or a
 * private room's host setting, is a deliberate choice and overrides it.
 */
export function defaultBotTarget(arenaSizeWU: number): number {
  const roomFor = Math.floor(arenaSizeWU ** 2 / BALANCE.bots.areaPerEntityWU2);
  return Math.max(0, Math.min(BALANCE.bots.targetPopulation, roomFor));
}

/** Health-probe payload — small, dependency-free, trivially assertable. */
export function healthPayload(commit: string): {
  status: 'ok';
  service: 'paintclash';
  phase: 'walking-skeleton';
  commit: string;
} {
  return { status: 'ok', service: 'paintclash', phase: 'walking-skeleton', commit };
}

/**
 * Durable Object name of the one public arena (ADR-0004). Lowercase, so it can
 * never collide with a room code: those are uppercase by construction
 * (`ROOM_CODE.alphabet`), which is what lets a code be a DO name verbatim.
 */
const PUBLIC_ARENA = 'public';

/**
 * Fresh codes tried before giving up. A collision means the drawn code already
 * names a live room — at ~10⁹ combinations and a handful of live rooms that is
 * astronomically unlikely, but it is checked rather than assumed: a collision
 * would drop a player into strangers' room, so "unlikely" is not good enough.
 */
export const ROOM_CODE_ATTEMPTS = 5;

/**
 * Bytes drawn per code attempt. Generous on purpose: `roomCodeFrom` skips the
 * biased tail of the byte range (~3 % of draws), so plenty of spare bytes make
 * the "ran out of entropy" path a formality rather than a retry loop.
 */
const CODE_DRAW_BYTES = 64;

/** Random bytes from the runtime's CSPRNG — the only impure thing in here. */
function cryptoBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/**
 * A fresh room code. `draw` is injectable so the unbiased fold and its
 * out-of-entropy guard can be tested without stubbing `crypto`.
 */
export function freshRoomCode(draw: (size: number) => Uint8Array = cryptoBytes): string {
  const code = roomCodeFrom(draw(CODE_DRAW_BYTES));
  if (code === null) {
    // Unreachable with a working CSPRNG (it would need ~59 of 64 bytes to land
    // in the 3 % rejected tail). Loud rather than silent: a broken source of
    // randomness must not degrade into predictable room codes.
    throw new Error('room code generator ran out of entropy');
  }
  return code;
}

/**
 * The host's secret for one room (ticket 14). It answers exactly one question —
 * "may this socket change the settings and press start?" — and nothing else: it
 * is not an identity, carries no player data, and a room it belongs to is gone
 * within `graceSeconds` of the last player leaving. 128 bits from the CSPRNG,
 * because the alternative (first socket wins) hands the room to whoever the
 * network favours when a link is shared.
 */
export function freshHostToken(draw: (size: number) => Uint8Array = cryptoBytes): string {
  return [...draw(16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Header the router stamps the caller's address into before it forwards a socket
 * to an arena (spec §8.3 point 3, ticket 15).
 *
 * `CF-Connecting-IP` is the lever, and it is trustworthy in exactly one place:
 * here, on a request that came through Cloudflare's edge, which overwrites it.
 * The arena still has to know the address — a cap on concurrent sockets per
 * address can only be counted where the live sockets are (`arena-do.ts`) — so the
 * router restamps the value it vouches for, unconditionally: a client that sends
 * this header itself has it replaced, which is the whole reason for `set` rather
 * than `append` and for a header of our own rather than passing `CF-Connecting-IP`
 * along as if the DO could tell the two apart.
 */
export const CLIENT_IP_HEADER = 'X-Paintclash-IP';

/**
 * The address everything without one counts as. Exported because all three
 * places that read an address have to agree on it — the router here, the gate DO
 * and the arena DO: were they to drift apart, an anonymous caller would hold a
 * different bucket in each and quietly walk past every per-IP cap.
 */
export const UNKNOWN_ADDRESS = 'unknown';

/**
 * The caller's address, or `UNKNOWN_ADDRESS`. A request without the header is not
 * a reason to skip a budget — everything anonymous then shares one bucket, which
 * is the safe direction (the alternative makes a missing header the way around
 * every per-IP cap).
 */
function callerIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? UNKNOWN_ADDRESS;
}

/**
 * Charge one action to an address (spec §8.3 point 3 + 6). Returns the refusal to
 * answer with, or `null` when the caller may proceed.
 *
 * **Fails open.** If the gate itself cannot answer — the object is being
 * restarted, a deploy invalidated it, the platform is shedding load — the caller
 * is let through rather than refused. Spec §8.1 puts availability first, and a
 * rate limiter that turns its own bad minute into "nobody may play" is a worse
 * outage than the abuse it exists to slow down.
 *
 * The cost is honest: a flood heavy enough to knock this one object over is also
 * the flood that would then go uncounted. That trade is acceptable because the
 * caps which protect the arena ITSELF — population, per-address sockets, the
 * frame budget — live in the arena and do not depend on this object at all. This
 * one only slows down how fast someone may knock.
 */
async function refusedByGate(env: Env, bucket: GateBucket, ip: string): Promise<Response | null> {
  const gate = env.ROOM_GATE.get(env.ROOM_GATE.idFromName('rooms'));
  let charged: Response;
  try {
    charged = await gate.fetch(`https://gate/charge?bucket=${bucket}&ip=${encodeURIComponent(ip)}`);
  } catch {
    return null;
  }
  if (charged.status !== 429) return null;
  return new Response('too many requests from this address', {
    status: 429,
    headers: { 'Retry-After': charged.headers.get('Retry-After') ?? '60' },
  });
}

/**
 * Route health → JSON, `POST /api/rooms` → a fresh private room, `/ws` → the
 * public Arena-DO or the room named by `?room=`, everything else → assets.
 */
export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') {
    return Response.json(healthPayload(env.COMMIT_SHA));
  }
  if (url.pathname === '/api/rooms') {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    return createRoom(request, env);
  }
  if (url.pathname === '/ws') return openSocket(request, env, url);
  return env.ASSETS.fetch(request);
}

/**
 * Route one socket to its arena: the public one, or the room its code names.
 * Charged against the caller's join budget first (spec §8.3 point 3) — a refused
 * open must not reach a Durable Object, which is the whole point of counting
 * reconnect spam and code guessing in front of them.
 */
async function openSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const wish = url.searchParams.get('room');
  // One normalizer for routing and for validation (`shared/room.ts`): a second
  // one would eventually address a room by a string the first would not.
  // Checked BEFORE the budget, so a hand-typed URL costs nothing at all; a code
  // guesser sends well-formed codes and is charged like everyone else.
  const code = wish === null ? null : normalizeRoomCode(wish);
  // Nothing legitimate gets here — the client checks the same rule before it
  // opens a socket — so the plain 4xx is for hand-typed URLs, not a UX path.
  if (wish !== null && code === null) return new Response('invalid room code', { status: 400 });
  const ip = callerIp(request);
  const refused = await refusedByGate(env, 'join', ip);
  // A WebSocket upgrade answered with a status is all a browser gets to see
  // here: no socket is opened, so there is no close code to carry a reason. The
  // audience for a refusal at this rate is a script, and a player who trips it
  // behind a shared address sees the client's generic "reconnect" message.
  if (refused) return refused;
  // Phase 1: exactly one public arena at a fixed address (ADR-0004). For a
  // private room the code IS the DO name (`idFromName(code)`); the room reads its
  // own canonical code out of storage, so nothing downstream re-normalizes.
  const arena = env.ARENA.get(env.ARENA.idFromName(code ?? PUBLIC_ARENA));
  try {
    return await arena.fetch(withCallerIp(request, ip));
  } catch {
    // A Durable Object whose code was replaced rejects the first request that
    // reaches it and asks to be retried ("… changed, invalidating this Durable
    // Object"); the object is rebuilt from the new code for the second. That
    // happens on every deploy and on every reload under `wrangler dev`, and
    // without this the first player to arrive after one would be told the game
    // is broken. Safe by construction: an upgrade that threw established no
    // socket, so a retry cannot connect anyone twice. One attempt only — a
    // second failure is a real fault and belongs in the response. The stub is
    // taken again rather than reused: the old one refers to the object that was
    // just replaced.
    return env.ARENA.get(env.ARENA.idFromName(code ?? PUBLIC_ARENA)).fetch(
      withCallerIp(request, ip),
    );
  }
}

/**
 * The same request with the caller's address stamped on (see
 * `CLIENT_IP_HEADER`). Rebuilt rather than mutated because an incoming request's
 * headers are immutable; the upgrade rides along in the copied headers.
 */
function withCallerIp(request: Request, ip: string): Request {
  const headers = new Headers(request.headers);
  headers.set(CLIENT_IP_HEADER, ip);
  return new Request(request, { headers });
}

/**
 * Create a private room (spec §2.6): charge the caller's address, draw a code
 * nobody is using, and hand back the code, the host secret and the link to
 * share. The room itself is the Durable Object the code names — this endpoint
 * only writes its config there (ADR-0004: registry in the room's own SQLite).
 */
async function createRoom(request: Request, env: Env): Promise<Response> {
  // Spec §8.3 point 6: every room is a DO plus a SQLite write, charged to the
  // address `CF-Connecting-IP` names.
  const refused = await refusedByGate(env, 'create', callerIp(request));
  if (refused) return refused;
  // The host may pre-set the room; anything unusable falls back to the spec's
  // defaults, and the lobby is where the settings are really made anyway.
  const config = sanitizeRoomConfig(await readJson(request));
  const hostToken = freshHostToken();
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt++) {
    const code = freshRoomCode();
    const room = env.ARENA.get(env.ARENA.idFromName(code));
    const created = await room.fetch('https://room/room', {
      method: 'POST',
      body: JSON.stringify({ code, config, hostToken }),
    });
    // 409 = that code already names a live room. Draw again.
    if (created.status === 409) continue;
    if (!created.ok) return new Response('could not create the room', { status: 502 });
    return Response.json({
      code,
      hostToken,
      url: roomShareLink(new URL(request.url).origin, code),
    });
  }
  return new Response('no free room code', { status: 503 });
}

/** The request body as JSON, or `null` — a bad body is a wish, not an error. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
