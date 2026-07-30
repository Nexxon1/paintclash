import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * The one scenario file that needs a POPULATED arena (ticket 12): the bot target
 * is a property of the arena DO's environment, and the main scenario config
 * pins it off (`hermetic`) so every other choreography stays undisturbed. This
 * config takes the wrangler config's top level instead, which is the arena as
 * production runs it — same worker, same protocol, same rules.
 *
 * Run by `pnpm test:scenario` after the main pass (see package.json).
 */
export default defineWorkersConfig({
  test: {
    include: ['bots.test.ts'],
    allowOnly: false,
    testTimeout: 60_000,
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
