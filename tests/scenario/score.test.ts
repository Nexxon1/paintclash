import { SELF } from 'cloudflare:test';
import { LIMITS, TICK_DT_SEC } from '@paintclash/shared';
import { lifeScore } from '@paintclash/sim-core';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 09, spec §2.5/§10.5): the own score over the real wire — a
 * real Arena-DO in workerd, a headless sim-client on the real binary protocol.
 * Three things matter here and none can be seen one seam down:
 *
 * 1. **A running life is reported to its own pilot**, on the score cadence,
 *    with the counters the server accumulated (peak share, ticks lived, the
 *    company average) — no client-side guessing of any of them.
 * 2. **A death closes the life**: a `final` frame carries the last word, and
 *    a client can turn it into the score with the shared formula.
 * 3. **The next life starts at zero** — the score is per life, not per session.
 */

/**
 * A fresh caller address per socket (README rule 6, ticket 15). Socket opens are
 * rate-limited per address and one address may hold only so many at once
 * (spec §8.3 point 3) — sharing one across a suite that opens dozens would make
 * a choreography fail for a reason that has nothing to do with what it tests.
 */
let nextCaller = 0;
function freshCaller(): string {
  nextCaller += 1;
  return `192.0.2.${String(nextCaller)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: string,
  timeoutMs = 60000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
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
      // The test tore this socket down while a queued frame was still
      // flushing. Uncaught, it lands in the DO's event loop as an unhandled
      // TypeError and buries the real failure in a wall of workerd stacks.
    }
  }, name);
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') client.receive(event.data);
  });
  client.join();
  return { client, ws };
}

/**
 * Drive a self-cut: straight out of the start block, then a held max-rate
 * turn — the full circle closes onto the own trail (spec §2.1). The same
 * maneuver the unit tests use, here through the real input timeline.
 */
function circleToDeath(client: SimClient, selfId: number): void {
  let ticks = 0;
  client.onSnapshot = (snapshot) => {
    if (!snapshot.players.some((p) => p.id === selfId)) return;
    ticks += 1;
    client.queueTurn(ticks > 14 ? 1 : 0);
    client.flush();
  };
}

describe('own score over the real wire (ticket 09)', () => {
  it('reports the running life, closes it on death, and starts the next at zero', async () => {
    const player = await connect('scorer');
    try {
      await until(() => player.client.self(), 'spawn');
      const selfId = player.client.playerId ?? -1;

      // 1. The running life arrives on the cadence, with real counters.
      const live = await until(() => {
        const frame = player.client.score;
        return frame && frame.lifeTicks > 0 ? frame : null;
      }, 'the first own-score frame');
      expect(live.final).toBe(false);
      // The 6×6 start block is 0,09 % of the 200 WU arena — the life's peak
      // until a fill beats it, and NOT something the client computed.
      expect(live.peakPct).toBeCloseTo(0.09, 2);
      // Alone in the arena: no company multiplier (bots would not count
      // either, spec §10.5).
      expect(live.avgOtherHumans).toBe(0);
      expect(live.lifeTicks).toBeGreaterThan(0);

      // The frames keep coming as the life runs on.
      const advanced = await until(() => {
        const frame = player.client.score;
        return frame && frame.lifeTicks > live.lifeTicks + LIMITS.scoreIntervalTicks ? frame : null;
      }, 'the life advancing');
      expect(advanced.lifeTicks).toBeGreaterThan(live.lifeTicks);

      // 2. Death closes the life: exactly one final frame, and the shared
      //    formula turns it into the score the HUD would show.
      circleToDeath(player.client, selfId);
      const death = await until(
        () => player.client.deaths.find((d) => d.victimId === selfId),
        'the self-cut death',
      );
      expect(death.killerId).toBe(selfId);
      const final = await until(() => player.client.finishedLives[0], 'the final score frame');
      expect(final.final).toBe(true);
      expect(final.peakPct).toBeCloseTo(0.09, 2);
      expect(final.lifeTicks).toBeGreaterThan(advanced.lifeTicks);
      const score = lifeScore({
        peakPct: final.peakPct,
        survivalSec: final.lifeTicks * TICK_DT_SEC,
        avgOtherHumans: final.avgOtherHumans,
      });
      // A solo life on nothing but the start block scores single digits —
      // the point is that it is a real, positive number from real counters.
      expect(score).toBeGreaterThan(0);

      // 3. The respawned life starts over (spec §2.5: the score is per life).
      player.client.onSnapshot = null;
      const fresh = await until(() => {
        const frame = player.client.score;
        return frame && !frame.final && frame.lifeTicks < final.lifeTicks ? frame : null;
      }, 'the next life’s first frame');
      expect(fresh.final).toBe(false);
      expect(fresh.lifeTicks).toBeLessThan(final.lifeTicks);
      expect(fresh.peakPct).toBeCloseTo(0.09, 2);
    } finally {
      player.ws.close();
    }
  });
});
