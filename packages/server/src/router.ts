/**
 * Router-Worker (spec §5.2, ADR-0004): stateless entry — serves the static
 * client via Workers Static Assets, answers the health probe, and routes
 * WebSocket connections to the one public Arena-DO. Seam for the later
 * matchmaker / private rooms (ticket 14). Kept free of `cloudflare:workers`
 * imports so it stays unit-testable in plain node.
 */

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
