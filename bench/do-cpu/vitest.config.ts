import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Runs every test of this package inside workerd (real Durable Object runtime).
 * The sweep can take minutes at high entity counts — hence the long timeout.
 * Not part of the root Vitest run/coverage (spec §9.3): this is a spike.
 */
export default defineWorkersConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 600_000,
    poolOptions: {
      workers: {
        singleWorker: true,
        // The bench holds its world in memory only; per-test storage
        // isolation would also trip over the SQLite -shm side files of
        // sqlite-backed DO classes.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
