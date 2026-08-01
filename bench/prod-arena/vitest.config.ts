import { defineConfig } from 'vitest/config';

/**
 * Plain node, and deliberately so: this bench does not simulate anything — it
 * OPENS REAL SOCKETS to a deployed arena and reads what that arena reports
 * about itself. The runtime under test is Cloudflare's, on the other end of the
 * wire; workerd here would only sandbox the driver.
 *
 * The load run flies minutes of arena time, hence the generous timeout.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 1_200_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
