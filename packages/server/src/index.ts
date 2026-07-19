/**
 * Router-Worker (spec §5.2, ADR-0004): stateless entry — serves the static
 * client via Workers Static Assets, answers the health probe, and routes
 * WebSocket connections to the one public Arena-DO. Seam for the later
 * matchmaker / private rooms (ticket 14).
 *
 * Free-plan / no-credit-card safe: SQLite-backed DO only (ADR-0001).
 */

export { ArenaDO } from './arena-do.js';

/** Bindings declared in `wrangler.jsonc`. */
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly COMMIT_SHA: string;
  readonly ARENA: DurableObjectNamespace;
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

export default {
  fetch: handleFetch,
};
