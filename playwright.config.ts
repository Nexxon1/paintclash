import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E config (spec §9.5 step 4, §9.7). Curated browser-driven
 * mechanics land with the client; for now this keeps the mandatory E2E job
 * wired. `forbidOnly` fails the CI run on a stray `.only`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
});
