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
