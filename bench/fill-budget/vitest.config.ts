import { defineConfig } from 'vitest/config';

/**
 * Plain node — deliberately NOT workerd. This bench measures `sim-core`'s own
 * arithmetic, which is the same code in both runtimes; the workers pool would
 * only add a sandbox whose timer resolution and JIT warmup we would then have
 * to reason about. `bench/do-cpu` is the one that needs a real DO (it measures
 * the DO's own overheads); this one needs a stopwatch around `step`.
 *
 * The budget run simulates minutes of arena time, so the timeout is generous.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 900_000,
    // One file at a time: two arenas competing for cores would measure the
    // scheduler, not the fill.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
