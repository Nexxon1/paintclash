import { SELF } from 'cloudflare:test';
import type { ArenaStatsPayload } from '@paintclash/server/arena';
import { TICK_HZ } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * The tick-budget probe over the real wire (ticket 16): `GET /api/arena-stats`
 * is how the population limit gets re-checked against real Cloudflare hardware,
 * so what it reports has to be right on a runtime nobody can attach a debugger
 * to. This suite holds the two halves that could silently rot — the endpoint
 * answering at all, and the numbers in it describing the arena that is actually
 * running.
 *
 * What it deliberately does NOT assert is the tick COST. What that number means
 * depends on the runtime — locally the clock advances during synchronous work,
 * on Cloudflare it does not (see `tick-cost.ts`) — so a threshold here would be
 * an assertion about workerd's clock, and on a shared runner a GC stall would
 * decide it.
 */

/** A fresh caller address per socket (README rule 6, ticket 15). */
let nextCaller = 0;
function freshCaller(): string {
  nextCaller += 1;
  return `192.0.2.${String(nextCaller)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStats(): Promise<ArenaStatsPayload> {
  const response = await SELF.fetch('https://arena/api/arena-stats');
  expect(response.status, 'the stats probe must answer').toBe(200);
  return response.json<ArenaStatsPayload>();
}

/**
 * Wait for the arena to REPORT progress rather than for the clock to pass
 * (README rule 3). A slow runner then makes this test slower, not red — and the
 * ~3.5 s workerd stalls that `wrangler dev` shows every ~34 s cannot decide the
 * outcome, which a fixed `sleep` would have let them do.
 */
async function untilTicks(atLeast: number, timeoutMs = 20_000): Promise<ArenaStatsPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stats = await readStats();
    if ((stats.tickCost?.ticks ?? 0) >= atLeast) return stats;
    if (Date.now() > deadline) {
      throw new Error(
        `the arena reported only ${String(stats.tickCost?.ticks ?? 0)} of ${String(atLeast)} ` +
          `ticks — its ticker never got going`,
      );
    }
    await sleep(50);
  }
}

async function connect(name: string): Promise<{ client: SimClient; ws: WebSocket }> {
  const response = await SELF.fetch('https://arena/ws', {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': freshCaller() },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error('server did not upgrade the connection');
  ws.accept();
  const client = new SimClient((frame) => {
    try {
      ws.send(frame);
    } catch {
      // Socket torn down while a queued frame was flushing (see the other
      // scenario files): swallowing it keeps the DO's event loop clean.
    }
  }, name);
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') client.receive(event.data);
  });
  client.join();
  return { client, ws };
}

describe('arena stats probe (ticket 16)', () => {
  it('answers for an arena that is not running, without starting one', async () => {
    // Order matters only in that this runs before anything joins in THIS file;
    // a shared arena that another file left running would report `live`, which
    // is why the assertion is about the shape rather than about `live` itself.
    const stats = await readStats();
    expect(stats).toHaveProperty('live');
    expect(stats).toHaveProperty('load');
    expect(stats).toHaveProperty('tickCost');
  });

  it('reports the load and the cadence of the arena that is running', async () => {
    const { client, ws } = await connect('budget-probe');
    try {
      const spawnBy = Date.now() + 15_000;
      while (!client.self() && Date.now() < spawnBy) await sleep(25);
      expect(client.self(), 'the probe client never spawned').not.toBeNull();
      // A second of ticks' worth of PROGRESS, not of clock (README rule 3).
      const stats = await untilTicks(TICK_HZ);

      expect(stats.live, 'an arena with a spawned player must report as live').toBe(true);
      const load = stats.load;
      const tick = stats.tickCost;
      if (!load || !tick) throw new Error('a live arena reported no load and no ticks');

      expect(load.connections, 'the one socket this test opened').toBe(1);
      expect(load.humans, 'the one player this test joined').toBe(1);
      // README rule 5: this environment is bot-free, so the arena holds exactly
      // the head this test connected.
      expect(load.bots, 'this environment runs with ARENA_BOTS=0').toBe(0);
      expect(load.tick, 'the sim must have advanced, not just the ticker').toBeGreaterThan(0);
      expect(load.vertices, 'a spawn block has corners to count').toBeGreaterThan(0);

      // Every tick recorded lands in exactly one bucket — the report's own
      // internal consistency, which no runner speed can influence.
      expect(tick.buckets.reduce((sum, n) => sum + n, 0)).toBe(tick.ticks);
      // Deliberately NOT an assertion about the tick COST. Its meaning depends
      // on the runtime (`tick-cost.ts`), and on a shared runner a stall would
      // decide it. What is asserted is that the recorder is not stuck: a broken
      // ticker reports 0 Hz, and one running on the wrong clock reports orders
      // of magnitude off — neither is a slow-runner symptom.
      expect(tick.observedHz, 'the ticker reported no cadence at all').toBeGreaterThan(TICK_HZ / 4);
      expect(tick.observedHz, 'the ticker is not pacing on the 50 ms grid').toBeLessThan(
        TICK_HZ * 4,
      );
      // The premise every cost in that report stands on. Local workerd runs its
      // clock during synchronous work; on Cloudflare it does not, and there the
      // numbers are structurally zero rather than good news (ticket 16).
      expect(tick.clockAdvances, 'local workerd used to advance its clock').toBe(true);
    } finally {
      ws.close();
    }
  });

  it('refuses to be written to', async () => {
    const response = await SELF.fetch('https://arena/api/arena-stats', { method: 'POST' });
    expect(response.status).toBe(405);
  });
});
