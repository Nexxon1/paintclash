// Cross-view offset: page A drives; sample AT THE SAME WALL CLOCK both
// A's own rendered pose and how B renders A. Distance in WU → seconds (÷9).
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
await a.keyboard.down('ArrowRight'); // circle — stays clear of walls
await a.waitForTimeout(2000);

const samples = [];
for (let i = 0; i < 60; i++) {
  const [selfA, seenByB] = await Promise.all([
    a.evaluate(() => {
      const s = window.__paintclash.lastRender?.self;
      return s ? { x: s.x, y: s.y } : null;
    }),
    b.evaluate(() => {
      const o = window.__paintclash.lastRender?.others[0];
      return o ? { x: o.x, y: o.y } : null;
    }),
  ]);
  if (selfA && seenByB) samples.push(Math.hypot(selfA.x - seenByB.x, selfA.y - seenByB.y));
  await a.waitForTimeout(500);
}
samples.sort((p, q) => p - q);
const pct = (p) => samples[Math.floor((p / 100) * (samples.length - 1))];
const stats = {
  n: samples.length,
  p50WU: +pct(50).toFixed(2),
  p95WU: +pct(95).toFixed(2),
  maxWU: +samples[samples.length - 1].toFixed(2),
  p50Sec: +(pct(50) / 9).toFixed(2),
  p95Sec: +(pct(95) / 9).toFixed(2),
};
console.log(base, '→ Sichten-Versatz:', JSON.stringify(stats));
await browser.close();
process.exit(0);
