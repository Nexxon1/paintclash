import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 03): the full vertical slice in a real browser — enter
 * a name, join the public arena, steer with a real keyboard. Everything the
 * headless layers cannot see: DOM wiring, WebSocket from the page, canvas
 * bootstrap, keyboard events.
 */

interface DebugPose {
  x: number;
  y: number;
  heading: number;
}

async function join(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  // Ready = welcomed + own player in a snapshot; the overlay disappears.
  await page.waitForSelector('#overlay', { state: 'hidden', timeout: 15_000 });
}

function pose(page: Page): Promise<DebugPose> {
  return page.evaluate(() => {
    const session = window.__paintclash?.session;
    const sample = session?.renderSample(1).self;
    if (!sample) throw new Error('no session/self yet');
    return { x: sample.x, y: sample.y, heading: sample.heading };
  });
}

test('a player joins and steers the head with the keyboard', async ({ page }) => {
  await join(page, 'E2E-Kopf');

  const before = await pose(page);
  await page.waitForTimeout(500);
  const cruising = await pose(page);
  // The head moves on its own at constant speed.
  const moved = Math.hypot(cruising.x - before.x, cruising.y - before.y);
  expect(moved).toBeGreaterThan(1);

  // Real keyboard input: hold ArrowRight ~½ s → heading must turn.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(500);
  await page.keyboard.up('ArrowRight');
  const turned = await pose(page);
  expect(turned.heading).not.toBeCloseTo(cruising.heading, 1);

  // The canvas is live and sized.
  const canvas = page.locator('#game');
  await expect(canvas).toBeVisible();
});

test('two browsers share one arena', async ({ browser }) => {
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await join(pageA, 'Alice');
  await join(pageB, 'Bob');

  // Each client eventually renders exactly one other player.
  await expect
    .poll(
      () => pageA.evaluate(() => window.__paintclash?.session.renderSample(1).others.length ?? -1),
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect
    .poll(
      () => pageB.evaluate(() => window.__paintclash?.session.renderSample(1).others.length ?? -1),
      { timeout: 10_000 },
    )
    .toBe(1);

  await pageA.close();
  await pageB.close();
});
