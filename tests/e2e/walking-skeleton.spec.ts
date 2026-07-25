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

  // Territory sync reached the browser client (ticket 04): the own start
  // block arrived and renders as a real polygon.
  const ownTerritory = await page.evaluate(() => {
    const state = window.__paintclash?.lastRender;
    return state?.territories.find((t) => t.playerId === state.selfId)?.territory ?? null;
  });
  expect(ownTerritory).not.toBeNull();
  expect(ownTerritory?.[0]?.[0]?.length ?? 0).toBeGreaterThanOrEqual(4);
});

test('movement renders smoothly — no reconciliation jerks, no frozen enemies', async ({
  browser,
}) => {
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  // Each head starts circling IMMEDIATELY after its join: the 1.6 WU-radius
  // orbit stays on the own start block (safespace — no trail), so nobody
  // ever self-cuts. Joining both first would let A cruise far off its block
  // while B joins; the then-held circle is a full-circle self-cut (ticket
  // 05), and the respawn teleport poisons the speed buckets whenever it
  // lands inside the sampling window — the flakiest failure this test had.
  await join(pageA, 'Smooth-A');
  await pageA.keyboard.down('ArrowRight');
  await join(pageB, 'Smooth-B');
  await pageB.keyboard.down('ArrowRight');
  await pageA.waitForTimeout(1000);

  // Sample the actually-rendered pose every frame for 3 s and measure the
  // speed per ~50 ms bucket. Sim speed is 9 WU/s; jerks (double-steps,
  // stalls, pops) push many buckets far off 9, a ghost/frozen enemy
  // collapses the mean. The dispersion measure is deliberately ROBUST
  // (median absolute deviation), never raw sd: shared CI runners hitch
  // legitimately and the bounded glide/timewarp recovery after a hitch is
  // LEGAL speed variation — a handful of such buckets blew raw sd past any
  // usable threshold (flaked repeatedly on GitHub runners at sd ≈ 3), while
  // the median barely moves. The guarded pathologies wobble EVERY bucket,
  // which no median can ignore.
  interface SpeedStats {
    mean: number;
    /** Median absolute deviation from the median speed. */
    mad: number;
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
            const median = (sorted: readonly number[]): number =>
              sorted[Math.floor(sorted.length / 2)] ?? 99;
            const speeds = (px: 'sx' | 'ox', py: 'sy' | 'oy'): SpeedStats => {
              const values: number[] = [];
              let last = samples[0];
              if (!last) return { mean: 0, mad: 99, max: 99, outlierPct: 100 };
              for (const s of samples) {
                if (s.t - last.t >= 50) {
                  values.push(
                    (Math.hypot(s[px] - last[px], s[py] - last[py]) / (s.t - last.t)) * 1000,
                  );
                  last = s;
                }
              }
              const mean = values.reduce((a, b) => a + b, 0) / values.length;
              const mid = median([...values].sort((a, b) => a - b));
              const mad = median(values.map((v) => Math.abs(v - mid)).sort((a, b) => a - b));
              // Outside 9 WU/s ± the legal glide/warp envelope.
              const outliers = values.filter((v) => v < 6 || v > 14).length;
              return {
                mean,
                mad,
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
  // Always in the report — a CI failure should show every metric, not just
  // the first tripped expect.
  console.log(`smoothness stats ${JSON.stringify(stats)}`);

  // Margins sized for shared CI runners; the guarded regressions still trip
  // loudly: frozen ghost ≈ mean 0, double-step jerks ≈ >50 % outliers and
  // every bucket ~4.5 off-median (mad), teleports ≈ max spikes. Clean-run
  // baselines: self mad ≈ 1.1–1.5 (reconciliation wobble while turning at
  // max rate), other mad ≈ 0.3–0.6 (interpolation smooths it).
  expect(stats.self.mean).toBeGreaterThan(6);
  expect(stats.self.mean).toBeLessThan(11);
  expect(stats.self.mad).toBeLessThan(2.2);
  expect(stats.self.outlierPct).toBeLessThan(25);
  expect(stats.other.mean).toBeGreaterThan(6);
  expect(stats.other.mean).toBeLessThan(11.5);
  expect(stats.other.mad).toBeLessThan(2.2);
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
      new Promise<{ maxJumpExcessWU: number; maxTurnExcessDeg: number }>((resolve) => {
        const TWO_PI = 2 * Math.PI;
        const dAng = (a: number, b: number): number => {
          let d = (b - a) % TWO_PI;
          if (d > Math.PI) d -= TWO_PI;
          if (d < -Math.PI) d += TWO_PI;
          return Math.abs(d);
        };
        let prev: { t: number; x: number; y: number; h: number } | null = null;
        let maxJumpExcessWU = 0;
        let maxTurnExcessDeg = 0;
        const t0 = performance.now();
        let stalled = false;
        function frame(now: number): void {
          const self = window.__paintclash?.lastRender?.self;
          if (self) {
            if (prev) {
              // Every rendered transition counts — including the frame that
              // spans the stall itself: the pose must glide, never leap.
              // Budgets are dt-based (CI runners render 40–90 ms frames):
              // legal sim motion (9 WU/s, 320 °/s) scales with the frame,
              // the correction glide (5 WU/s, 240 °/s) with the client's
              // 100 ms decay cap, plus fixed slack. A reset blows past this
              // at any frame rate.
              const dt = now - prev.t;
              const glideDt = Math.min(dt, 100) / 1000;
              const jump = Math.hypot(self.x - prev.x, self.y - prev.y);
              const turn = (dAng(prev.h, self.heading) * 180) / Math.PI;
              const jumpBudget = (dt / 1000) * 9 + glideDt * 5 + 0.3;
              const turnBudget = (dt / 1000) * 320 + glideDt * 240 + 10;
              maxJumpExcessWU = Math.max(maxJumpExcessWU, jump - jumpBudget);
              maxTurnExcessDeg = Math.max(maxTurnExcessDeg, turn - turnBudget);
            }
            prev = { t: now, x: self.x, y: self.y, h: self.heading };
          }
          if (!stalled && now - t0 > 300) {
            stalled = true;
            const until = performance.now() + 800;
            for (;;) if (performance.now() >= until) break;
          }
          if (now - t0 < 2500) requestAnimationFrame(frame);
          else resolve({ maxJumpExcessWU, maxTurnExcessDeg });
        }
        requestAnimationFrame(frame);
      }),
  );
  await page.keyboard.up('ArrowRight');

  // No rendered transition may exceed its motion budget. A reset (pre-fix:
  // 2–3 WU and 100–155° inside ordinary ~16 ms frames) overshoots by miles.
  expect(result.maxJumpExcessWU).toBeLessThanOrEqual(0);
  expect(result.maxTurnExcessDeg).toBeLessThanOrEqual(0);
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
