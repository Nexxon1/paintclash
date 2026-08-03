import { defineConfig } from 'vitest/config';

/**
 * Plain node, same reasoning as `bench/fill-budget`: what is measured here is
 * how many bytes `encodeTerritory` produces for real, saturated territories,
 * and that is the same arithmetic in workerd. The transport is deliberately
 * absent — this bench counts what the send path in `arena.ts` WOULD hand to
 * each socket, not what a WebSocket does with it afterwards.
 *
 * The measurement run simulates hours of arena time, so the timeout is
 * generous.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 1_800_000,
    // One arena at a time. Not for stopwatch reasons — this bench has no
    // stopwatch — but because a saturated 200 WU arena is memory-hungry and
    // two of them competing would only measure the allocator.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
