import { defineConfig } from 'vitest/config';

/**
 * Plain node, like `../fill-budget`: what is measured here is the carve's
 * polygon arithmetic, which a browser runs on the same JS engine. The parts a
 * browser adds on top (GL upload, compositing) are not what froze the frame —
 * see the README.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 900_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
