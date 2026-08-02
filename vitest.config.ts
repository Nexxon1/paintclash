import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config (spec §9.3). One run covers every package; coverage
 * gates are declared **per package** as glob-keyed thresholds — the mechanical
 * "no shortcuts" floor that only ever rises.
 *
 * `shared` is exempt from coverage where it is sanity-only (§9.3) — file by
 * file, so a module with real logic in it cannot inherit the exemption.
 * Scenario/E2E tests live
 * outside this config (`tests/scenario`, `tests/e2e`) and do not count toward %.
 *
 * The one exception is `tests/scenario/lib/`: the pure measures a choreography
 * is written in terms of (ticket 27). They are unit tests by CONTEXT.md's own
 * definition — no server, no socket — so they run here in milliseconds rather
 * than starting workerd. They are test scaffolding, not shipped code, so like
 * every other `*.test.ts` they stay out of the coverage numerator (below).
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/scenario/lib/**/*.test.ts'],
    // `.only` fails the run unless explicitly allowed (spec §9.6).
    allowOnly: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/dist/**',
        // `shared` is sanity-only (§9.3) — declared constants, no branches to
        // cover. Its nickname policy (ticket 13) is the exception: real
        // branching logic that both ends of the wire depend on, so it is
        // measured and gated like any other module.
        'packages/shared/src/balance.ts',
        'packages/shared/src/limits.ts',
        'packages/shared/src/types.ts',
        'packages/shared/src/index.ts',
        // Transport/DO shell — exercised by the scenario tests (tests/scenario/),
        // which run in workerd and don't count toward % (spec §9.3:
        // hibernation/transport justifiably exempt). Every rule it applies lives
        // elsewhere and IS measured: the game in `arena.ts`, the frame budget in
        // `flood.ts`, the room policy in `shared/room.ts`. The one decision it
        // makes itself is counting a live socket per address (ticket 15) —
        // unavoidable here, because only the shell can see the sockets, and
        // driven end-to-end by `tests/scenario/abuse.test.ts`.
        'packages/server/src/arena-do.ts',
        // Same: storage shell around `room-gate.ts`, whose rule IS unit-tested.
        // The shell itself is driven end-to-end by the rate-limit choreography
        // in `tests/scenario/room.test.ts`.
        'packages/server/src/room-gate-do.ts',
        // Worker entry re-export (imports cloudflare:workers via the DO) —
        // wiring only, exercised by the scenario tests.
        'packages/server/src/index.ts',
        // Rendering + DOM/WS bootstrap are excluded per spec §9.3 ("client
        // logic ≥ 80%, Render ausgenommen"); the Playwright E2E covers them.
        'packages/client/src/render/**',
        'packages/client/src/main.ts',
        'packages/client/vite.config.ts',
      ],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        // What the exclusions above leave measured in `shared`: the nickname
        // policy and the room policy (ticket 14). Both are pure decision logic
        // that both ends of the wire depend on, and neither has an excuse for
        // an uncovered branch.
        'packages/shared/src/**/*.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
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
