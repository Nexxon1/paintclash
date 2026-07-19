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
