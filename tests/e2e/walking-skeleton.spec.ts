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

test('movement renders smoothly — no reconciliation jerks, no frozen enemies', async ({
  browser,
}) => {
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await join(pageA, 'Smooth-A');
  await join(pageB, 'Smooth-B');
  // Circling (radius 1.6 WU) keeps both heads clear of the wall slide.
  await pageA.keyboard.down('ArrowRight');
  await pageB.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(1000);

  // Sample the actually-rendered pose every frame for 3 s and measure the
  // speed per ~50 ms bucket. Sim speed is 9 WU/s; jerks (double-steps,
  // stalls, pops) blow up the standard deviation, a ghost/frozen enemy
  // collapses the mean.
  const stats = await pageA.evaluate(
    () =>
      new Promise<{ self: { mean: number; sd: number }; other: { mean: number; sd: number } }>(
        (resolve) => {
          const samples: { t: number; sx: number; sy: number; ox: number; oy: number }[] = [];
          const t0 = performance.now();
          function frame(now: number): void {
            const state = window.__paintclash?.lastRender;
            const self = state?.self;
            const other = state?.others[0];
            if (self && other)
              samples.push({ t: now, sx: self.x, sy: self.y, ox: other.x, oy: other.y });
            if (now - t0 < 3000) requestAnimationFrame(frame);
            else {
              const speeds = (px: 'sx' | 'ox', py: 'sy' | 'oy'): { mean: number; sd: number } => {
                const values: number[] = [];
                let last = samples[0];
                if (!last) return { mean: 0, sd: 99 };
                for (const s of samples) {
                  if (s.t - last.t >= 50) {
                    values.push(
                      (Math.hypot(s[px] - last[px], s[py] - last[py]) / (s.t - last.t)) * 1000,
                    );
                    last = s;
                  }
                }
                const mean = values.reduce((a, b) => a + b, 0) / values.length;
                const sd = Math.sqrt(
                  values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
                );
                return { mean, sd };
              };
              resolve({ self: speeds('sx', 'sy'), other: speeds('ox', 'oy') });
            }
          }
          requestAnimationFrame(frame);
        },
      ),
  );

  // Wide margins so CI-runner jank never flakes this; the guarded regressions
  // (frozen ghost ≈ 0 mean, double-step jerks ≈ sd > 2) still trip loudly.
  expect(stats.self.mean).toBeGreaterThan(7);
  expect(stats.self.mean).toBeLessThan(11);
  expect(stats.self.sd).toBeLessThan(1.5);
  expect(stats.other.mean).toBeGreaterThan(7);
  expect(stats.other.mean).toBeLessThan(11.5);
  expect(stats.other.sd).toBeLessThan(2);

  await pageA.close();
  await pageB.close();
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
