// Diagnostic: how fast does a steer press reach the AUTHORITATIVE state on
// the deployed server, and do any presses get eaten? Reads the newest
// snapshot's turn echo out of the session's interpolator buffer.
// Usage: node steer-latency-probe.mjs <baseUrl>
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'https://paintclash.secure-data.workers.dev';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(base + '/');
await page.fill('#name', 'steer-probe');
await page.click('#join-form button');
await page.waitForSelector('#overlay', { state: 'hidden', timeout: 20000 });
await page.waitForTimeout(1000);

const results = [];
for (let i = 0; i < 14; i++) {
  const applied = await page.evaluate(async () => {
    const session = window.__paintclash.session;
    const id = session.playerId;
    const newestSelfTurn = () => {
      const buf = session.interpolator.buffer;
      const newest = buf[buf.length - 1];
      return newest?.players.find((p) => p.id === id)?.turn ?? null;
    };
    // Reconciliation lag: pending = own seqs the server has not acked yet.
    // Healthy: oscillates 1..4. Zero means the ack RUNS AHEAD of the client's
    // seq timeline — every input is arriving after its mapped tick (eaten).
    const lag = () => session.predictor.pending.length;
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    let appliedAt = null;
    while (performance.now() - t0 < 1500) {
      if (newestSelfTurn() === 1) {
        appliedAt = performance.now() - t0;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
    // wait for the release to land too, so runs don't overlap
    const r0 = performance.now();
    let releasedAt = null;
    while (performance.now() - r0 < 1500) {
      if (newestSelfTurn() === 0) {
        releasedAt = performance.now() - r0;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return { appliedAt, releasedAt, lag: lag(), seq: session.nextSeq - 1 };
  });
  results.push(applied);
  await page.waitForTimeout(600);
}
const ok = results.filter((r) => r.appliedAt !== null).map((r) => r.appliedAt);
ok.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      presses: results.length,
      eaten: results.filter((r) => r.appliedAt === null).length,
      p50ms: ok.length ? +ok[Math.floor(0.5 * (ok.length - 1))].toFixed(0) : null,
      maxMs: ok.length ? +ok[ok.length - 1].toFixed(0) : null,
      all: results.map((r) => ({
        press: r.appliedAt === null ? 'EATEN' : Math.round(r.appliedAt),
        release: r.releasedAt === null ? 'EATEN' : Math.round(r.releasedAt),
        lag: r.lag,
        seq: r.seq,
      })),
    },
    null,
    1,
  ),
);
await browser.close();
process.exit(0);
