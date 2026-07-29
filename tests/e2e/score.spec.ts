import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 09, spec §2.5): the own score in a real browser — the
 * HUD panel, the records line on the join card and the localStorage envelope
 * behind it, none of which the headless layers can see (the formula is pinned
 * in `sim-core`'s `score.test.ts`, the display rules in `game/score.test.ts`
 * and the wire path in `tests/scenario/score.test.ts`).
 */

async function join(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  await page.waitForSelector('#overlay', { state: 'hidden', timeout: 15_000 });
}

test('the score panel counts the running life up beside the personal record', async ({ page }) => {
  // A first-ever visit: no records yet, and the card says so.
  await page.goto('/');
  await expect(page.locator('#records')).toHaveText(/Noch keine Rekorde/);
  const stored = await page.evaluate(() => localStorage.getItem('paintclash.player.v1'));
  // The identity is minted and persisted before a single life is played —
  // it is what later carries the records to an account (ADR-0006 seam 4).
  expect(JSON.parse(stored ?? '{}')).toMatchObject({
    version: 1,
    records: { highscore: 0, maxAreaPct: 0, longestSurvivalSec: 0 },
  });

  await join(page, 'Score-E2E');

  // The panel appears with the first score frame (≤ 500 ms after the spawn).
  const panel = page.locator('#score');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const value = panel.locator('.score-value');
  await expect(value).toHaveText(/^[\d.]+$/);
  // No record yet, so the panel shows an em dash — and any score at all beats
  // it, which is what the highlight means.
  await expect(panel.locator('.score-record')).toHaveText('Rekord —');

  // Survival alone lifts the score (spec §10.5: √survival), so the number
  // must climb while the head cruises — the point of a LIVE estimate.
  const read = async (): Promise<number> =>
    Number.parseInt((await value.textContent())?.replace(/\./g, '') ?? '0', 10);
  const first = await read();
  await expect.poll(read, { timeout: 20_000, intervals: [500] }).toBeGreaterThan(first);
});
