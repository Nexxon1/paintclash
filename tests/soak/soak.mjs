// Soak test: 60 s under combined real-world adversity. Fails loudly on any
// reset/teleport/freeze — the user-reported symptoms.
// Usage: node soak.mjs <baseUrl>
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';

async function join(page, name) {
  await page.goto(base + '/');
  await page.fill('#name', name);
  await page.click('#join-form button');
  await page.waitForSelector('#overlay', { state: 'hidden', timeout: 20000 });
}

const browser = await chromium.launch();
const a = await (await browser.newContext()).newPage();
const b = await (await browser.newContext()).newPage();
await join(a, 'soak-watch');
await join(b, 'soak-enemy');

// B = the "second window": render loop fully frozen (GPU-throttled), but
// steering — the timer-driven sim must keep it alive and moving.
await b.evaluate(() => {
  window.requestAnimationFrame = () => 0;
});
await b.keyboard.down('ArrowRight');

// A: mild periodic jank (real browsers under load).
await a.evaluate(() => {
  setInterval(() => {
    const until = performance.now() + 100 + Math.random() * 150;
    for (;;) if (performance.now() >= until) break;
  }, 1200);
  const rec = {
    resets: [],
    frames: 0,
    selfSpeeds: [],
    otherSpeeds: [],
    otherFrozen: 0,
    otherSamples: 0,
    othersMissing: 0,
  };
  window.__rec = rec;
  const TWO_PI = 2 * Math.PI;
  const dAng = (x, y) => {
    let d = (y - x) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    return Math.abs(d);
  };
  let prevSelf = null,
    lastSelfBucket = null,
    lastOtherBucket = null;
  function frame(now) {
    const st = window.__paintclash.lastRender;
    rec.frames++;
    const self = st?.self;
    const other = st?.others[0];
    if (!other) rec.othersMissing++;
    if (self && prevSelf) {
      const dt = now - prevSelf.t;
      // dt-normalized budget: legal movement (9 WU/s) + max glide (5 WU/s)
      // plus margin — this also judges the first frame AFTER a stall (the
      // classic reset frame), which a small-dt-only check would skip.
      const jumpBudget = (dt / 1000) * (9 + 5) + 0.5;
      const turnBudgetDeg = (dt / 1000) * (320 + 240) + 10;
      const jump = Math.hypot(self.x - prevSelf.x, self.y - prevSelf.y);
      const turn = (dAng(prevSelf.h, self.heading) * 180) / Math.PI;
      if (jump > jumpBudget || turn > turnBudgetDeg)
        rec.resets.push({
          jump: +jump.toFixed(2),
          turnDeg: +turn.toFixed(0),
          dtMs: +dt.toFixed(0),
        });
    }
    if (self) prevSelf = { t: now, x: self.x, y: self.y, h: self.heading };
    if (self) {
      if (lastSelfBucket && now - lastSelfBucket.t >= 50 && now - lastSelfBucket.t < 120) {
        rec.selfSpeeds.push(
          (Math.hypot(self.x - lastSelfBucket.x, self.y - lastSelfBucket.y) /
            (now - lastSelfBucket.t)) *
            1000,
        );
      }
      if (!lastSelfBucket || now - lastSelfBucket.t >= 50)
        lastSelfBucket = { t: now, x: self.x, y: self.y };
    }
    if (other) {
      if (lastOtherBucket && now - lastOtherBucket.t >= 50 && now - lastOtherBucket.t < 120) {
        const v =
          (Math.hypot(other.x - lastOtherBucket.x, other.y - lastOtherBucket.y) /
            (now - lastOtherBucket.t)) *
          1000;
        rec.otherSpeeds.push(v);
        rec.otherSamples++;
        if (v < 2) rec.otherFrozen++;
      }
      if (!lastOtherBucket || now - lastOtherBucket.t >= 50)
        lastOtherBucket = { t: now, x: other.x, y: other.y };
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
});

// A tap-steers the whole time (turn transitions are the hot path).
const deadline = Date.now() + 60_000;
let i = 0;
while (Date.now() < deadline) {
  const key = i++ % 2 ? 'ArrowLeft' : 'ArrowRight';
  await a.keyboard.down(key);
  await a.waitForTimeout(200 + Math.random() * 200);
  await a.keyboard.up(key);
  await a.waitForTimeout(300 + Math.random() * 300);
}

const rec = await a.evaluate(() => {
  const r = window.__rec;
  const stats = (v) => {
    if (!v.length) return null;
    const mean = v.reduce((p, c) => p + c, 0) / v.length;
    const sd = Math.sqrt(v.reduce((p, c) => p + (c - mean) ** 2, 0) / v.length);
    return {
      n: v.length,
      mean: +mean.toFixed(2),
      sd: +sd.toFixed(2),
      max: +Math.max(...v).toFixed(2),
    };
  };
  return {
    frames: r.frames,
    selfResets: r.resets.length,
    worstResets: r.resets.slice(0, 5),
    self: stats(r.selfSpeeds),
    other: stats(r.otherSpeeds),
    otherFrozenPct: +((100 * r.otherFrozen) / Math.max(1, r.otherSamples)).toFixed(1),
    othersMissingFrames: r.othersMissing,
  };
});
console.log(base, '→', JSON.stringify(rec, null, 1));
const pass =
  rec.selfResets === 0 &&
  rec.otherFrozenPct < 3 &&
  (rec.other?.max ?? 99) < 25 &&
  rec.othersMissingFrames < rec.frames * 0.02;
console.log(pass ? 'SOAK: PASS' : 'SOAK: FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
