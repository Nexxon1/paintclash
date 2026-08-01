import { SELF } from 'cloudflare:test';
import { BALANCE, LIMITS } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 12, spec §2.7): the arena's population over the real wire —
 * a real Arena-DO in workerd with bots switched ON (this file runs from
 * `vitest.bots.config.ts`, which takes the wrangler config's top level; every
 * other scenario file runs in its bot-free `hermetic` environment). Three
 * things matter here and none of them can be seen one seam down:
 *
 * 1. **A lone human is joined by bots**, to `clamp(target − humans, 0, maxBots)`
 *    — and the client SEES them: real ids in real snapshots, with real start
 *    blocks synced, indistinguishable from network players.
 * 2. **Humans first, both ways.** Every human that arrives retires a bot, so the
 *    population stays at the target instead of growing past it — and every human
 *    that leaves hands the slot back, so it does not empty out either.
 * 3. **Bots are no company** (spec §10.5): the human's own score frame, which
 *    the server alone computes, reports zero other humans.
 *
 * Deliberately NOT asserted: what the bots do with their turn. That is unit
 * territory (`packages/server/src/bot.test.ts`), where a stalled pilot names
 * itself instead of hiding behind a flaky population count.
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
  what: () => string,
  timeoutMs = 25000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
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

/** How many entities the client's newest snapshot shows. */
function population(client: SimClient): number {
  return client.snapshot?.players.length ?? 0;
}

const { targetPopulation, maxBots } = BALANCE.bots;

describe('arena population (ticket 12, spec §2.7)', () => {
  it('follows the clamp rule as humans join and leave', { timeout: 120_000 }, async () => {
    const humans = [await connect('Mensch-1')];
    try {
      const self = await until(
        () => humans[0]?.client.self(),
        () => 'the human’s own spawn',
      );
      // clamp(8 − 1, 0, 8) = 7 bots alongside → 8 entities.
      const client = humans[0]?.client;
      if (!client) throw new Error('no client');
      await until(
        () => population(client) === targetPopulation,
        () =>
          `the arena to fill to ${String(targetPopulation)} (saw ${String(population(client))})`,
      );

      // The bots are ordinary players on the wire: distinct ids, and a start
      // block synced like anyone else's — a client cannot tell them apart,
      // which is exactly the point of ADR-0005 (no special path).
      const seen = client.snapshot?.players.map((p) => p.id) ?? [];
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toContain(self.id);
      await until(
        () => seen.every((id) => client.territoryAreaOf(id) > 0),
        () => 'every entity’s start block to arrive as a territory sync',
      );

      // Humans first: each new one takes a bot's slot, the total stands still.
      while (humans.length < targetPopulation) {
        humans.push(await connect(`Mensch-${String(humans.length + 1)}`));
        const count = humans.length;
        await until(
          () => (humans[count - 1]?.client.self() ? true : null),
          () => `human ${String(count)} to spawn`,
        );
        // Only ever `targetPopulation`: a bot left for every human that came.
        await until(
          () => population(client) === targetPopulation,
          () =>
            `the population to stay at ${String(targetPopulation)} with ` +
            `${String(count)} humans (saw ${String(population(client))})`,
        );
      }

      // One human past the target: nobody is displaced, and no bot returns.
      humans.push(await connect('Mensch-zuviel'));
      await until(
        () => population(client) === targetPopulation + 1,
        () =>
          `the ${String(targetPopulation + 1)}th human to be simply added ` +
          `(saw ${String(population(client))})`,
      );
      // Sanity on the ceiling: the population never exceeded target + humans.
      expect(population(client)).toBeLessThanOrEqual(humans.length + maxBots);

      // ...and the other direction: a human who leaves hands the slot back to
      // a bot, so the arena stays populated instead of emptying out. Two go,
      // because the first only undoes the one human past the target.
      for (let i = 0; i < 2; i++) humans.pop()?.ws.close();
      await until(
        () => population(client) === targetPopulation,
        () =>
          `the population to refill to ${String(targetPopulation)} after two ` +
          `humans left (saw ${String(population(client))})`,
      );
    } finally {
      for (const human of humans) human.ws.close();
    }
  });

  it(
    'bots are no company: a human among bots scores as if alone (spec §10.5)',
    { timeout: 120_000 },
    async () => {
      const solo = await connect('Einzelgänger');
      try {
        await until(
          () => solo.client.self(),
          () => 'the human’s own spawn',
        );
        await until(
          () => population(solo.client) === targetPopulation,
          () => 'the arena to fill with bots',
        );
        // The score's company term is server-computed and personal — the client
        // never guesses it, so this is the only place it can be checked.
        const score = await until(
          () =>
            solo.client.score && solo.client.score.lifeTicks > LIMITS.scoreIntervalTicks
              ? solo.client.score
              : null,
          () => 'an own-score frame past the first cadence',
        );
        expect(score.avgOtherHumans).toBe(0);
      } finally {
        solo.ws.close();
      }
    },
  );
});
