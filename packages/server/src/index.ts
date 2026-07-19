/**
 * Placeholder Cloudflare Worker (spec §5.2, §7.1). Serves the static client via
 * Workers Static Assets and answers a health probe. The real Router-Worker plus
 * Arena Durable Object land in later build tickets (02+).
 *
 * Free-plan / no-credit-card safe: no bindings that require a paid plan.
 *
 * @see ADR-0001, ADR-0004
 */

/** Bindings declared in `wrangler.jsonc`. `ASSETS` serves the static client. */
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Health-probe payload — small, dependency-free, trivially assertable. */
export function healthPayload(): {
  status: 'ok';
  service: 'paintclash';
  phase: 'placeholder';
} {
  return { status: 'ok', service: 'paintclash', phase: 'placeholder' };
}

/** Route health checks to JSON; delegate everything else to Static Assets. */
export function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') {
    return Promise.resolve(Response.json(healthPayload()));
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch: handleFetch,
};
