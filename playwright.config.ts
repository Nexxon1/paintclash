import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E (spec §9.1/9.5): a curated handful of browser-real checks —
 * input devices, render wiring — on top of the headless scenario tests. The
 * web server is the real thing: built client behind `wrangler dev` with the
 * Arena-DO in workerd. `forbidOnly` fails the CI run on a stray `.only`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  // The smoothness/stall specs assert real frame pacing; their metrics are
  // robust to ordinary shared-runner hitches (see walking-skeleton.spec.ts),
  // but a runner in genuine distress (multi-hundred-ms freezes) makes the
  // client SNAP by design — indistinguishable from a bug in one sample. One
  // retry covers that tail; Playwright still reports such runs as "flaky",
  // so they stay visible instead of silently green.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
  },
  webServer: {
    command: 'pnpm run e2e:server',
    url: 'http://127.0.0.1:8787/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
