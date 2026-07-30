/**
 * Router-Worker (spec §5.2, ADR-0004): stateless entry — serves the static
 * client via Workers Static Assets, answers the health probe, and routes
 * WebSocket connections to the one public Arena-DO. Seam for the later
 * matchmaker / private rooms (ticket 14). Kept free of `cloudflare:workers`
 * imports so it stays unit-testable in plain node.
 */

import { BALANCE } from '@paintclash/shared';

/** Bindings declared in `wrangler.jsonc`. */
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly COMMIT_SHA: string;
  readonly ARENA: DurableObjectNamespace;
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

/** Route health → JSON, /ws → public Arena-DO, everything else → assets. */
export function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') {
    return Promise.resolve(Response.json(healthPayload(env.COMMIT_SHA)));
  }
  if (url.pathname === '/ws') {
    // Phase 1: exactly one public arena at a fixed address (ADR-0004).
    const stub = env.ARENA.get(env.ARENA.idFromName('public'));
    return stub.fetch(request);
  }
  return env.ASSETS.fetch(request);
}
