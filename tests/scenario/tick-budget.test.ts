import { SELF } from 'cloudflare:test';
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
 * What it deliberately does NOT assert is the tick COST. Locally the clock
 * advances during synchronous work, so lateness reads ~0 whatever a tick
 * spends; the measurement only carries cost on a clock-freezing runtime (see
 * `tick-cost.ts`). Asserting a number here would be asserting the local
 * runtime's clock behaviour, not the arena's.
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

interface StatsPayload {
  live: boolean;
  arena: { tick: number; sizeWU: number; connections: number; humans: number; bots: number } | null;
  tick: { ticks: number; observedHz: number; overBudgetTicks: number; buckets: number[] } | null;
}

async function readStats(): Promise<StatsPayload> {
  const response = await SELF.fetch('https://arena/api/arena-stats');
  expect(response.status, 'the stats probe must answer').toBe(200);
  return response.json<StatsPayload>();
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
    expect(stats).toHaveProperty('arena');
    expect(stats).toHaveProperty('tick');
  });

  it('reports the population and the cadence of the arena that is running', async () => {
    const { client, ws } = await connect('budget-probe');
    try {
      const deadline = Date.now() + 15_000;
      while (!client.self() && Date.now() < deadline) await sleep(25);
      expect(client.self(), 'the probe client never spawned').not.toBeNull();
      // Two seconds of ticks: enough that a rate derived from the gaps between
      // them is a rate and not a rounding artefact.
      await sleep(2000);

      const stats = await readStats();
      expect(stats.live, 'an arena with a spawned player must report as live').toBe(true);
      const arena = stats.arena;
      const tick = stats.tick;
      if (!arena || !tick) throw new Error('a live arena reported no population or no ticks');

      expect(arena.connections).toBe(1);
      expect(arena.humans).toBe(1);
      // README rule 5: this environment is bot-free, so the arena holds exactly
      // the head this test connected.
      expect(arena.bots).toBe(0);
      expect(arena.tick).toBeGreaterThan(TICK_HZ);

      expect(tick.ticks).toBeGreaterThan(TICK_HZ);
      // The cadence the DO's own clock saw. Local workerd paces honestly, so a
      // rate far off nominal here means the ticker's schedule is broken — the
      // production skew (ticket 18) is a property of Cloudflare's clock, not of
      // this loop.
      expect(tick.observedHz).toBeGreaterThan(TICK_HZ * 0.8);
      expect(tick.observedHz).toBeLessThan(TICK_HZ * 1.2);
      expect(tick.buckets.reduce((sum, n) => sum + n, 0)).toBe(tick.ticks);
      expect(tick.overBudgetTicks).toBe(0);
    } finally {
      ws.close();
    }
  });

  it('refuses to be written to', async () => {
    const response = await SELF.fetch('https://arena/api/arena-stats', { method: 'POST' });
    expect(response.status).toBe(405);
  });
});
