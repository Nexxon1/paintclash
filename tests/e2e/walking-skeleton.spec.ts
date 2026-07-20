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
  // Read the pose the page actually drew — renderSample() mutates session
  // state (render clock, adaptive delay) and must stay the app's call.
  return page.evaluate(() => {
    const sample = window.__paintclash?.lastRender?.self;
    if (!sample) throw new Error('no rendered self yet');
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
  // stalls, pops) push many buckets far off 9, a ghost/frozen enemy
  // collapses the mean. The discriminator is the OUTLIER FRACTION, not raw
  // sd: shared CI runners hitch legitimately (glide phases inflate sd a
  // little), while the historical double-step bug threw every other bucket
  // out of band (> 50 % outliers).
  interface SpeedStats {
    mean: number;
    sd: number;
    max: number;
    outlierPct: number;
  }
  const stats = await pageA.evaluate(
    () =>
      new Promise<{ self: SpeedStats; other: SpeedStats }>((resolve) => {
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
            const speeds = (px: 'sx' | 'ox', py: 'sy' | 'oy'): SpeedStats => {
              const values: number[] = [];
              let last = samples[0];
              if (!last) return { mean: 0, sd: 99, max: 99, outlierPct: 100 };
              for (const s of samples) {
                if (s.t - last.t >= 50) {
                  values.push(
                    (Math.hypot(s[px] - last[px], s[py] - last[py]) / (s.t - last.t)) * 1000,
                  );
                  last = s;
                }
              }
              const mean = values.reduce((a, b) => a + b, 0) / values.length;
              const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
              // Outside 9 WU/s ± the legal glide/warp envelope.
              const outliers = values.filter((v) => v < 6 || v > 14).length;
              return {
                mean,
                sd,
                max: Math.max(...values),
                outlierPct: (100 * outliers) / values.length,
              };
            };
            resolve({ self: speeds('sx', 'sy'), other: speeds('ox', 'oy') });
          }
        }
        requestAnimationFrame(frame);
      }),
  );

  // Margins sized for shared CI runners; the guarded regressions still trip
  // loudly: frozen ghost ≈ mean 0, double-step jerks ≈ >50 % outliers +
  // sd > 2.5, teleports ≈ max spikes.
  expect(stats.self.mean).toBeGreaterThan(7);
  expect(stats.self.mean).toBeLessThan(11);
  expect(stats.self.sd).toBeLessThan(2.5);
  expect(stats.self.outlierPct).toBeLessThan(25);
  expect(stats.other.mean).toBeGreaterThan(7);
  expect(stats.other.mean).toBeLessThan(11.5);
  expect(stats.other.sd).toBeLessThan(2.5);
  expect(stats.other.outlierPct).toBeLessThan(25);
  // Display-side speed limit: enemies may catch up at ≤ 2.2× nominal, never
  // spike beyond (pre-fix: 160+ WU/s teleports).
  expect(stats.other.max).toBeLessThan(25);

  await pageA.close();
  await pageB.close();
});

test('recovers from a main-thread stall without teleporting or whipping around', async ({
  page,
}) => {
  await join(page, 'Stall-Test');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(400);

  // Record every rendered frame, inject an 800 ms main-thread freeze (a tab
  // switch / GC pause), keep recording through the recovery.
  const result = await page.evaluate(
    () =>
      new Promise<{ maxJumpWU: number; maxTurnDeg: number }>((resolve) => {
        const TWO_PI = 2 * Math.PI;
        const dAng = (a: number, b: number): number => {
          let d = (b - a) % TWO_PI;
          if (d > Math.PI) d -= TWO_PI;
          if (d < -Math.PI) d += TWO_PI;
          return Math.abs(d);
        };
        let prev: { t: number; x: number; y: number; h: number } | null = null;
        let maxJumpWU = 0;
        let maxTurnDeg = 0;
        const t0 = performance.now();
        let stalled = false;
        function frame(now: number): void {
          const self = window.__paintclash?.lastRender?.self;
          if (self) {
            if (prev) {
              // Every rendered transition counts — including the frame that
              // spans the stall itself: the pose must glide, never leap.
              maxJumpWU = Math.max(maxJumpWU, Math.hypot(self.x - prev.x, self.y - prev.y));
              maxTurnDeg = Math.max(maxTurnDeg, (dAng(prev.h, self.heading) * 180) / Math.PI);
            }
            prev = { t: now, x: self.x, y: self.y, h: self.heading };
          }
          if (!stalled && now - t0 > 300) {
            stalled = true;
            const until = performance.now() + 800;
            for (;;) if (performance.now() >= until) break;
          }
          if (now - t0 < 2500) requestAnimationFrame(frame);
          else resolve({ maxJumpWU, maxTurnDeg });
        }
        requestAnimationFrame(frame);
      }),
  );
  await page.keyboard.up('ArrowRight');

  // One 60-fps frame of legal movement is 0.15 WU / ~5.3°; corrections may
  // glide on top. A reset (pre-fix: 2–3 WU, 100–155°) must never reappear.
  expect(result.maxJumpWU).toBeLessThan(1.0);
  expect(result.maxTurnDeg).toBeLessThan(30);
});

test('two browsers share one arena', async ({ browser }) => {
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await join(pageA, 'Alice');
  await join(pageB, 'Bob');

  // Each client eventually renders exactly one other player (read from the
  // drawn state — renderSample() mutates session internals).
  await expect
    .poll(() => pageA.evaluate(() => window.__paintclash?.lastRender?.others.length ?? -1), {
      timeout: 10_000,
    })
    .toBe(1);
  await expect
    .poll(() => pageB.evaluate(() => window.__paintclash?.lastRender?.others.length ?? -1), {
      timeout: 10_000,
    })
    .toBe(1);

  await pageA.close();
  await pageB.close();
});
