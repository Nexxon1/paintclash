// Cross-view offset measured while DRIVING STRAIGHT through open field (a
// circling head hides the lag in a tiny chord; a wall-parked one shows 0).
// The driver is nudged away from walls; samples only count in open field.
// Offset ÷ 9 = total view lag in seconds.
// Usage: node tests/soak/offset-probe.mjs <baseUrl>
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
await join(a, 'driver');
await join(b, 'observer');
await a.waitForTimeout(1000);

const myId = await a.evaluate(() => window.__paintclash.session.playerId);
const samples = [];
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const selfA = await a.evaluate(() => {
    const s = window.__paintclash.lastRender?.self;
    return s ? { x: s.x, y: s.y } : null;
  });
  if (!selfA) continue;
  const nearWall = selfA.x < 20 || selfA.x > 180 || selfA.y < 20 || selfA.y > 180;
  if (nearWall) {
    await a.keyboard.down('ArrowRight'); // swing back into the field
    await a.waitForTimeout(450);
    await a.keyboard.up('ArrowRight');
    await a.waitForTimeout(600); // settle into a straight line again
    continue;
  }
  const [selfNow, seenByB] = await Promise.all([
    a.evaluate(() => {
      const s = window.__paintclash.lastRender?.self;
      return s ? { x: s.x, y: s.y } : null;
    }),
    b.evaluate((id) => {
      const o = window.__paintclash.lastRender?.others.find((p) => p.id === id);
      return o ? { x: o.x, y: o.y } : null;
    }, myId),
  ]);
  if (selfNow && seenByB) samples.push(Math.hypot(selfNow.x - seenByB.x, selfNow.y - seenByB.y));
  await a.waitForTimeout(300);
}
samples.sort((p, q) => p - q);
const pct = (p) => samples[Math.floor((p / 100) * (samples.length - 1))];
console.log(
  base,
  '→ Einzelsicht-Versatz (Geradeausfahrt, freies Feld):',
  JSON.stringify({
    n: samples.length,
    p50WU: +pct(50).toFixed(2),
    p95WU: +pct(95).toFixed(2),
    p50LagSec: +(pct(50) / 9).toFixed(2),
    zweiScreensDiskrepanzWU: +(2 * pct(50)).toFixed(1),
  }),
);
await browser.close();
process.exit(0);
