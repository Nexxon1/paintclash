// Diagnostic: measure the server's actual tick rate as seen by a client —
// snapshot tick delta over wall time. Expected: 20.00 Hz.
// Usage: node tests/soak/tickrate-probe.mjs <baseUrl>
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(base + '/');
await page.fill('#name', 'tickrate-probe');
await page.click('#join-form button');
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 20000 });
await page.waitForTimeout(500);

const rate = await page.evaluate(async () => {
  const session = window.__paintclash.session;
  const newestTick = () => {
    const buf = session.interpolator.buffer;
    return buf[buf.length - 1]?.tick ?? 0;
  };
  const t0 = performance.now();
  const tick0 = newestTick();
  await new Promise((r) => setTimeout(r, 15000));
  const dt = (performance.now() - t0) / 1000;
  return { hz: (newestTick() - tick0) / dt, seconds: dt };
});
console.log(
  base,
  '→ server tick rate:',
  rate.hz.toFixed(2),
  'Hz over',
  rate.seconds.toFixed(1),
  's',
);
await browser.close();
process.exit(0);
