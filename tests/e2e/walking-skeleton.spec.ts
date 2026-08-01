import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 03): the full vertical slice in a real browser — enter
 * a name, join the public arena, steer with a real keyboard. Everything the
 * headless layers cannot see: DOM wiring, WebSocket from the page, canvas
 * bootstrap, keyboard events.
 */

declare global {
  interface Window {
    /** Test-side scratch: frame-gap percentiles of the last smoothness sampling. */
    __gapProfile?: { p50: number; p90: number; p99: number; max: number };
  }
}

interface DebugPose {
  x: number;
  y: number;
  heading: number;
}

async function join(page: Page, name: string, holdRight = false): Promise<void> {
  await page.goto('/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  // `holdRight` presses ArrowRight BEFORE the session becomes ready (the
  // listener registers at page load), so the very first simulated tick
  // already circles: the 1.6 WU orbit stays on the own start block —
  // safespace. Pressing after readiness lets the head cruise off the block
  // during the keypress round-trip; a circle started ≥ ~1.2 WU out pokes
  // far enough into open field to become a full-circle self-cut (ticket
  // 05), and whether the respawn teleport then poisons a measurement is a
  // machine-speed lottery this suite kept losing on cold/slow machines.
  if (holdRight) await page.keyboard.down('ArrowRight');
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
  // Both heads circle on their start blocks from tick one (see join) —
  // deterministically deathless, whatever the machine speed.
  await join(pageA, 'Smooth-A', true);
  await join(pageB, 'Smooth-B', true);
  await pageA.waitForTimeout(1000);

  // Sample the actually-rendered pose every frame for 8 s and measure the
  // speed per ~50 ms bucket. Sim speed is 9 WU/s; jerks (double-steps,
  // stalls, pops) push buckets far off 9, a ghost/frozen enemy collapses
  // the mean. Only buckets with SOUND FRAME PACING are scored: on a busy
  // shared runner the bounded glide/timewarp recovery after a hitch is
  // LEGAL speed variation, and once hitching is the steady state (2-core
  // CI runners; mad 2.5+ measured on such runs), no statistic over ALL
  // buckets can separate a healthy client on a dying machine from a buggy
  // client on a healthy one. A bucket counts iff every frame gap in it is
  // ≤ 40 ms, it spans ≤ 100 ms, and it starts ≥ 150 ms after the last long
  // gap (the predictor's 100 ms correction decay must have drained). The
  // guarded pathologies live in ordinary frames, so they corrupt clean
  // buckets too. Dispersion stays robust (median absolute deviation).
  interface SpeedStats {
    mean: number;
    /** Median absolute deviation from the median speed. */
    mad: number;
    max: number;
    outlierPct: number;
    /** Buckets with sound frame pacing (scored) / all buckets. */
    clean: number;
    total: number;
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
          if (now - t0 < 8000) requestAnimationFrame(frame);
          else {
            const median = (sorted: readonly number[]): number =>
              sorted[Math.floor(sorted.length / 2)] ?? 99;
            // Frame-gap distribution — logged for flake triage/calibration.
            const gaps = samples
              .slice(1)
              .map((s, i) => s.t - (samples[i]?.t ?? s.t))
              .sort((a, b) => a - b);
            const gapAt = (q: number): number => gaps[Math.floor(gaps.length * q)] ?? 0;
            window.__gapProfile = {
              p50: gapAt(0.5),
              p90: gapAt(0.9),
              p99: gapAt(0.99),
              max: gaps[gaps.length - 1] ?? 0,
            };
            const speeds = (px: 'sx' | 'ox', py: 'sy' | 'oy'): SpeedStats => {
              const values: number[] = [];
              let total = 0;
              let last = samples[0];
              if (!last) return { mean: 0, mad: 99, max: 99, outlierPct: 100, clean: 0, total: 0 };
              let prevT = last.t;
              let contaminatedUntil = -Infinity;
              let dirty = false;
              for (const s of samples) {
                if (s.t - prevT > 40) contaminatedUntil = s.t + 150;
                prevT = s.t;
                if (s.t < contaminatedUntil) dirty = true;
                if (s.t - last.t >= 50) {
                  total += 1;
                  const dt = s.t - last.t;
                  if (!dirty && dt <= 100) {
                    values.push((Math.hypot(s[px] - last[px], s[py] - last[py]) / dt) * 1000);
                  }
                  last = s;
                  dirty = s.t < contaminatedUntil;
                }
              }
              if (values.length === 0)
                return { mean: 0, mad: 99, max: 99, outlierPct: 100, clean: 0, total };
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
                clean: values.length,
                total,
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
  const gapProfile = await pageA.evaluate(() => window.__gapProfile ?? null);
  console.log(`smoothness stats ${JSON.stringify(stats)} gaps ${JSON.stringify(gapProfile)}`);

  // Too few sound buckets = the runner could not hold frame pacing long
  // enough to measure anything. Skipping is honest and VISIBLE in the
  // report — a red herring assertion on garbage data is neither.
  test.skip(
    stats.self.clean < 12,
    `frame pacing too degraded to certify smoothness (${String(stats.self.clean)} clean of ${String(stats.self.total)} buckets)`,
  );

  // Margins sized for real hardware variance on SOUND buckets; the guarded
  // regressions still trip loudly: frozen ghost ≈ mean 0, double-step jerks
  // ≈ >50 % outliers and every bucket ~4.5 off-median (mad), teleports ≈
  // max spikes. Clean-run baselines: self mad ≈ 1.1–1.5 (reconciliation
  // wobble while turning at max rate), other mad ≈ 0.3–0.6 (interpolation
  // smooths it).
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
  // Circling on the block from tick one (see join) — the injected stall
  // must be the only violent event in this test.
  await join(page, 'Stall-Test', true);
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

test('circling in the own start block never flashes a trail (ticket 20)', async ({ page }) => {
  // The reported gesture, exactly: hold one steer key and orbit inside your
  // own block. The orbit does not fit (3.22 WU across a 6 WU block from its
  // centre), so the head really does graze past its own edge and a real trail
  // is carved every revolution — the sim is untouched here. It must simply
  // never be drawn.
  //
  // What this adds over the unit test at the session seam: real keyboard,
  // real frames, and above all the SERVER closing each loop. The reveal
  // budget is per excursion and resets on the fill frame; only a real arena
  // running many revolutions shows that the reset actually happens instead
  // of the budget creeping up over a life and revealing the graze late.
  await join(page, 'E2E-Streifer', true);
  const probe = await page.evaluate(async (ms: number) => {
    const started = performance.now();
    let ribbonFrames = 0;
    let visibleFrames = 0;
    let frames = 0;
    while (performance.now() - started < ms) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const state = window.__paintclash?.lastRender;
      if (!state || state.selfId === null) continue;
      frames += 1;
      const own = state.trails.find((t) => t.playerId === state.selfId);
      if (!own) continue;
      ribbonFrames += 1;
      if (own.visible) visibleFrames += 1;
    }
    return { frames, ribbonFrames, visibleFrames };
  }, 4000);
  await page.keyboard.up('ArrowRight');

  // Premise (README rule 2): the browser really did sample the game, and a
  // real trail really was carved out there. Without both, "nothing was
  // drawn" would only mean nothing happened.
  expect(probe.frames).toBeGreaterThan(60);
  expect(probe.ribbonFrames).toBeGreaterThan(0);
  // …and not one frame of it was ever put on screen.
  expect(probe.visibleFrames).toBe(0);
});

test('two browsers share one arena', async ({ browser }) => {
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  await join(pageA, 'Alice');
  await join(pageB, 'Bob');
  const idOf = (page: Page): Promise<number> =>
    page.evaluate(() => window.__paintclash?.session.playerId ?? -1);
  const idA = await idOf(pageA);
  const idB = await idOf(pageB);
  expect(idA).toBeGreaterThan(0);
  expect(idB).toBeGreaterThan(0);
  expect(idA).not.toBe(idB);

  // Each client eventually renders the OTHER browser's player (read from
  // the drawn state — renderSample() mutates session internals). Asserting
  // "exactly one other" instead would flake on stragglers from earlier
  // tests still draining from the shared arena — close events lag behind
  // on a loaded machine.
  await expect
    .poll(
      () =>
        pageA.evaluate(
          (id) => window.__paintclash?.lastRender?.others.some((o) => o.id === id) ?? false,
          idB,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect
    .poll(
      () =>
        pageB.evaluate(
          (id) => window.__paintclash?.lastRender?.others.some((o) => o.id === id) ?? false,
          idA,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);

  await pageA.close();
  await pageB.close();
});
