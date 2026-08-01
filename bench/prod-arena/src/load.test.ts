import { LIMITS, TICK_DT_MS } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { report, runLoad } from './probe.js';

/**
 * The ticket-16 measurement: hold a deployed arena at a chosen population and
 * read back what its ticks cost. Manual, never CI (spec §9.3) — it opens real
 * sockets against a real deployment and spends minutes of Free-plan budget
 * doing it (see the cost note in `probe.ts`).
 *
 * ```sh
 * # local wrangler dev (the control run)
 * pnpm dev &
 * pnpm --filter @paintclash/bench-prod-arena bench
 *
 * # production (the run the ticket is about)
 * PAINTCLASH_BASE_URL=https://paintclash.<subdomain>.workers.dev \
 *   pnpm --filter @paintclash/bench-prod-arena bench
 * ```
 *
 * `PAINTCLASH_CLIENTS` (default `LIMITS.maxPlayers`, i.e. the population limit
 * itself — the number the ticket has to confirm) and `PAINTCLASH_SECONDS`
 * (default 300, the window `bench/fill-budget` showed the fill cost still
 * climbing over) tune the run.
 *
 * There is no threshold assertion here on purpose. This is a MEASUREMENT, and
 * the arena on the other end is shared and best-effort (spec §8.5): a red bar
 * would say "somebody else was playing" as often as it says anything about the
 * budget. What it does assert is that the run happened — clients spawned and
 * the arena ticked — because a silent zero-load run reported as "well under
 * budget" is the one outcome that would mislead.
 */
const baseUrl = process.env.PAINTCLASH_BASE_URL ?? 'http://127.0.0.1:8787';
const clients = Number(process.env.PAINTCLASH_CLIENTS ?? String(LIMITS.maxPlayers));
const seconds = Number(process.env.PAINTCLASH_SECONDS ?? '300');

describe('tick budget of a deployed arena', () => {
  it(`${String(clients)} painting clients for ${String(seconds)} s against ${baseUrl}`, async () => {
    const result = await runLoad({ baseUrl, clients, seconds });
    console.log(report(result));

    expect(result.joined, 'no client ever spawned — is the arena reachable?').toBeGreaterThan(0);
    const last = result.samples[result.samples.length - 1]?.stats;
    expect(last?.tick?.ticks ?? 0, 'the arena reported no ticks at all').toBeGreaterThan(0);
    // The premise `pilot.test.ts` guards offline, re-checked over the wire: a
    // run without fills measures heads driving, not an arena painting, and its
    // tick cost would be meaningless.
    expect(result.fills, 'the clients never closed a loop').toBeGreaterThan(0);
    // Loud, not fatal — see above.
    const over = last?.tick?.overBudgetTicks ?? 0;
    if (over > 0) {
      console.log(
        `\n  ⚠ ${String(over)} ticks reached the ${String(TICK_DT_MS)} ms budget — ` +
          `the population limit needs re-reading (docs/benchmarks/do-cpu-benchmark.md).`,
      );
    }
  });
});
