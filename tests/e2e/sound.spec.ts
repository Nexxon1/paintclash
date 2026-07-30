import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 11, spec §4.4): the two things about sound that only a
 * real browser can answer — that the `AudioContext` really is unlocked by the
 * join click (the autoplay policy is browser behaviour, not logic), and that
 * the mute toggle in the HUD really persists.
 *
 * WHICH cue a frame owes is unit-tested headlessly (`game/sfx-cues.test.ts`),
 * and the audio graph's rules — one context, one master gain, one persistent
 * loop source, no node churn per frame — in `game/sfx.test.ts` against a fake
 * context. What is left here is the wiring, plus the browser's own policy.
 */

async function join(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  await page.waitForSelector('#overlay', { state: 'hidden', timeout: 15_000 });
}

/** The engine's self-report (`SfxEngine.stats`), once a game is running. */
function stats(page: Page) {
  return page.evaluate(() => window.__paintclash?.sfx.stats ?? null);
}

test('the join click unlocks the audio context and the spawn cue sounds', async ({ page }) => {
  await page.goto('/');
  // Sound is ON by default (spec §4.4) — the toggle says so before any click.
  const toggle = page.locator('.sound-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // No context yet: building one before the gesture would leave it suspended.
  expect(await stats(page)).toBe(null);

  await join(page, 'Sound-E2E');

  // The click WAS the unlock — no separate "enable sound" prompt exists, and
  // resume() resolves asynchronously, hence the poll.
  await expect
    .poll(async () => (await stats(page))?.contextState, { timeout: 10_000 })
    .toBe('running');
  // And the first own pose really reached the engine as the join cue: the whole
  // chain (session → cues → voices) ran in a real browser.
  await expect.poll(async () => (await stats(page))?.played.spawn, { timeout: 10_000 }).toBe(1);
  const running = await stats(page);
  expect(running?.muted).toBe(false);
  // Nothing else has any business sounding on an empty spawn.
  expect(running?.played).toMatchObject({ fill: 0, kill: 0, death: 0, rankup: 0 });
  expect(running?.eating).toBe(false);
});

test('the mute toggle silences the game and outlives a reload', async ({ page }) => {
  await join(page, 'Mute-E2E');
  const toggle = page.locator('.sound-toggle');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // The glyph is the state, the label is what a click would do.
  await expect(toggle).toHaveText('🔇');
  await expect(toggle).toHaveAttribute('aria-label', 'Ton einschalten');
  expect((await stats(page))?.muted).toBe(true);

  // Persisted next to the control mode, in the one settings envelope (spec §3).
  expect(await page.evaluate(() => localStorage.getItem('paintclash.settings.v1'))).toBe(
    JSON.stringify({ version: 1, controlMode: 'keyboard', muted: true }),
  );

  // A reload comes back silent — including the engine that is built fresh.
  await join(page, 'Mute-E2E');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect((await stats(page))?.muted).toBe(true);

  // And back on again: the toggle is binary, both ways.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('🔊');
  expect((await stats(page))?.muted).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('paintclash.settings.v1'))).toBe(
    JSON.stringify({ version: 1, controlMode: 'keyboard', muted: false }),
  );
});
