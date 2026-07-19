import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { PacedResult, RunResult } from './worker.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    BENCH_ARENA: DurableObjectNamespace;
  }
}

function stubFor(name: string): DurableObjectStub {
  return env.BENCH_ARENA.get(env.BENCH_ARENA.idFromName(name));
}

async function setup(stub: DurableObjectStub, entities: number): Promise<Response> {
  return stub.fetch('https://bench/setup', {
    method: 'POST',
    body: JSON.stringify({ seed: 1, entities, fill: 'raster', collision: 'grid' }),
  });
}

describe('BenchArena (echtes Durable Object)', () => {
  it('runs a throughput batch and reports stats + timing', async () => {
    const stub = stubFor('smoke-throughput');
    const res = await setup(stub, 8);
    expect(res.status).toBe(200);

    const run = await stub.fetch('https://bench/run?ticks=100');
    expect(run.status).toBe(200);
    const data = await run.json<RunResult>();
    expect(data.ticks).toBe(100);
    // 8 staggered entities close 7 loops within the first 100 ticks.
    expect(data.stats.fills).toBeGreaterThan(0);
    expect(data.stats.segmentChecks).toBeGreaterThan(0);
    expect(typeof data.msInternal).toBe('number');
    expect(typeof data.clockAdvanced).toBe('boolean');
  });

  it('runs a paced 20-Hz batch and reports per-tick lateness', async () => {
    const stub = stubFor('smoke-paced');
    await setup(stub, 4);
    const run = await stub.fetch('https://bench/run-paced?ticks=10');
    expect(run.status).toBe(200);
    const data = await run.json<PacedResult>();
    expect(data.ticks).toBe(10);
    // 10 ticks at 20 Hz take ~500 ms wall clock.
    expect(data.msWall).toBeGreaterThanOrEqual(400);
    expect(data.latenessMsP95).toBeGreaterThanOrEqual(0);
  });

  it('rejects a run before setup', async () => {
    const stub = stubFor('smoke-unset');
    const run = await stub.fetch('https://bench/run?ticks=10');
    expect(run.status).toBe(409);
  });
});
