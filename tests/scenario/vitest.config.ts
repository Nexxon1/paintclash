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
    // NO retry, deliberately (unlike `playwright.config.ts`, which retries
    // because it measures real frame pacing on a shared runner). These tests
    // are meant to be STABLE, not re-rolled: the spawns are pinned
    // (wrangler.jsonc), every stage waits on sim STATE rather than on a
    // wall-clock bet, and every premise miss names itself. A retry here would
    // hide the one signal that says a choreography has become fragile —
    // and the last thing this suite needs is a way to be quietly green.
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
