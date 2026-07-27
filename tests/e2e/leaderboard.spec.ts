import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 08, spec §2.5): the live leaderboard in a real browser —
 * the DOM HUD, the swatch colors and the own-row highlight, none of which the
 * headless layers can see (the ranking rules themselves are pinned in
 * `game/leaderboard.test.ts` and over the wire in `tests/scenario/`).
 */

async function join(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  await page.waitForSelector('#overlay', { state: 'hidden', timeout: 15_000 });
}

test('the HUD shows the own highlighted row with its swatch and share', async ({ page }) => {
  await join(page, 'HUD-Rang');

  const board = page.locator('#leaderboard');
  // Hidden until the first board arrives (≤ 500 ms after the spawn).
  await expect(board).toBeVisible({ timeout: 10_000 });

  const own = board.locator('li.row.self');
  await expect(own).toHaveCount(1);
  await expect(own.locator('.name')).toHaveText('HUD-Rang');
  await expect(own.locator('.rank')).toHaveText(/^\d+$/);
  // Share of the map, German decimals (spec §2.5: the metric is only %).
  await expect(own.locator('.percent')).toHaveText(/^\d+,\d{2} %$/);
  // The swatch carries the reserved own-blue, matching the own plateau.
  const swatch = await own
    .locator('.swatch')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(swatch).toBe('rgb(47, 127, 232)');

  // Never more rows than the board is allowed to show (top 5 + own).
  expect(await board.locator('li.row').count()).toBeLessThanOrEqual(6);
});

test('a second browser appears on the board with its own name and color', async ({ browser }) => {
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  try {
    await join(pageA, 'Board-A');
    await join(pageB, 'Board-B');

    // A's board lists B — an enemy row: not highlighted, and in B's own hue
    // rather than the reserved blue.
    const enemy = pageA.locator('#leaderboard li.row', { hasText: 'Board-B' });
    await expect(enemy).toHaveCount(1, { timeout: 10_000 });
    await expect(enemy).not.toHaveClass(/self/);
    const color = await enemy
      .locator('.swatch')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/); // a real color, not unset
    expect(color).not.toBe('rgb(47, 127, 232)'); // …and not the reserved blue
    // …and B sees itself highlighted on the same shared ranking.
    await expect(pageB.locator('#leaderboard li.row.self .name')).toHaveText('Board-B');
  } finally {
    await pageA.close();
    await pageB.close();
  }
});
