/**
 * Placeholder Cloudflare Worker (spec §5.2, §7.1). Serves the static client via
 * Workers Static Assets and answers a health probe that reports the deployed
 * commit SHA. The real Router-Worker plus Arena Durable Object land in later
 * build tickets (02+).
 *
 * Free-plan / no-credit-card safe: no bindings that require a paid plan.
 *
 * @see ADR-0001, ADR-0004
 */

/**
 * Bindings declared in `wrangler.jsonc`. `ASSETS` serves the static client;
 * `COMMIT_SHA` is the deployed git commit (a plain-text var; defaults to `dev`
 * locally and is overridden per deploy via `--var COMMIT_SHA:<sha>`).
 */
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly COMMIT_SHA: string;
}

/** Health-probe payload — small, dependency-free, trivially assertable. */
export function healthPayload(commit: string): {
  status: 'ok';
  service: 'paintclash';
  phase: 'placeholder';
  commit: string;
} {
  return { status: 'ok', service: 'paintclash', phase: 'placeholder', commit };
}

/** Route health checks to JSON; delegate everything else to Static Assets. */
export function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') {
    return Promise.resolve(Response.json(healthPayload(env.COMMIT_SHA)));
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch: handleFetch,
};
