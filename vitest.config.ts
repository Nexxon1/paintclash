import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config (spec §9.3). One run covers every package; coverage
 * gates are declared **per package** as glob-keyed thresholds — the mechanical
 * "no shortcuts" floor that only ever rises.
 *
 * `shared` is exempt from coverage (sanity-only, §9.3). Scenario/E2E tests live
 * outside this config (`tests/scenario`, `tests/e2e`) and do not count toward %.
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // `.only` fails the run unless explicitly allowed (spec §9.6).
    allowOnly: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/dist/**',
        'packages/shared/**',
        // Transport/DO shell without logic — exercised by the scenario tests
        // (tests/scenario/), which run in workerd and don't count toward %
        // (spec §9.3: hibernation/transport justifiably exempt).
        'packages/server/src/arena-do.ts',
        // Rendering + DOM/WS bootstrap are excluded per spec §9.3 ("client
        // logic ≥ 80%, Render ausgenommen"); the Playwright E2E covers them.
        'packages/client/src/render/**',
        'packages/client/src/main.ts',
        'packages/client/vite.config.ts',
      ],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        'packages/sim-core/src/**/*.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'packages/protocol/src/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/server/src/**/*.ts': {
          lines: 75,
          functions: 75,
          statements: 75,
          branches: 75,
        },
        'packages/client/src/**/*.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
        'packages/sim-client/src/**/*.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 80,
        },
      },
    },
  },
});
