import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Scenario tests (spec §9.1): a real server in workerd + sim-clients over the
 * real binary protocol, no browser/rendering. Separate from the root Vitest
 * run — they exercise the stack, they don't count toward coverage % (§9.3).
 */
export default defineWorkersConfig({
  test: {
    include: ['**/*.test.ts'],
    allowOnly: false,
    testTimeout: 30_000,
    // One retry in CI, none locally (same deal as `playwright.config.ts`): the
    // spawns are pinned (see wrangler.jsonc), so what is left to go wrong is
    // TICK TIMING on a contended shared runner — a choreography that misses a
    // window there is not a regression. Vitest still reports a retried test as
    // flaky, so it stays visible instead of silently green.
    retry: process.env.CI ? 1 : 0,
    poolOptions: {
      workers: {
        singleWorker: true,
        // The arena holds its world in memory only (ADR-0004); per-test
        // storage isolation would also trip over SQLite -shm side files.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
