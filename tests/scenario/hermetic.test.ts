import { SELF } from 'cloudflare:test';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * The suite's own premise, asserted once (README rule 5, ticket 12): this
 * environment runs **bot-free**, so every choreography here holds exactly the
 * heads its test connected.
 *
 * It exists because the switch is a string in a config file. `ARENA_BOTS: "0"`
 * turns the population off, but `botTargetOverride` treats anything it cannot
 * parse as "not set" and the arena then falls back to the full production
 * target — so a typo (`"O"`, `"false"`, a stray space) turns bots ON. Without
 * this test that surfaces as six unrelated choreographies failing on premises
 * that no longer come about, each blaming its own stage. README rule 2 says
 * every premise failure names itself; this is that rule applied to the premise
 * the whole suite shares.
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

describe('scenario environment (README rule 5)', () => {
  it('is bot-free — the arena holds only the heads a test connected', async () => {
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
    }, 'Einzelgänger');
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') client.receive(event.data);
    });
    client.join();
    try {
      const deadline = Date.now() + 15_000;
      while (!client.self() && Date.now() < deadline) await sleep(25);
      expect(client.self(), 'the lone client never spawned').not.toBeNull();
      // Give a bot population, if one were switched on, the two ticks it needs
      // to spawn — otherwise this would pass before it could ever be wrong.
      await sleep(500);
      const population = client.snapshot?.players.length ?? 0;
      expect(
        population,
        `${String(population)} entities for ONE connected client — this suite is ` +
          `running WITH bots. Check ARENA_BOTS in tests/scenario/wrangler.jsonc: ` +
          `it must be "0" under env.hermetic, and anything unparseable silently ` +
          `means "use the production target".`,
      ).toBe(1);
    } finally {
      ws.close();
    }
  });
});
