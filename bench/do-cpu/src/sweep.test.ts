/**
 * The actual measurement run (`pnpm bench`). Not part of `pnpm test` — it
 * takes minutes. Results feed docs/benchmarks/do-cpu-benchmark.md.
 *
 * All timing happens *outside* the DO across the fetch boundary: awaiting
 * I/O advances the clock even on runtimes that freeze `Date.now()` during
 * synchronous CPU work, so these numbers are valid regardless of the
 * runtime's Spectre hardening. Batches are auto-sized to >= ~100 ms so the
 * loopback-fetch overhead (<1 ms) stays in the noise.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { CollisionMode, FillMode } from './load.js';
import type { PacedResult, RunResult } from './worker.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    BENCH_ARENA: DurableObjectNamespace;
  }
}

interface Combo {
  fill: FillMode;
  collision: CollisionMode;
}

/** naive+polygon = the unmitigated first implementation; grid+raster = the
 * mitigated target implementation; the mixed combos attribute the cost. */
const COMBOS: Combo[] = [
  { fill: 'polygon', collision: 'naive' },
  { fill: 'polygon', collision: 'grid' },
  { fill: 'raster', collision: 'naive' },
  { fill: 'raster', collision: 'grid' },
];

const N_LIST = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
const WARMUP_TICKS = 200; // every entity past its first loop close
const BATCHES = 8;

const PACED_N = new Map<string, number[]>([
  ['polygon/naive', [8, 16, 32]],
  ['raster/grid', [16, 32, 64, 128]],
]);
const PACED_TICKS = 200; // 10 s of real 20-Hz time

interface Row {
  combo: string;
  n: number;
  msPerTickAvg: number;
  msPerTickP95: number;
  msPerTickMax: number;
  segChecksPerTick: number;
  fillsPerSecond: number;
  clockAdvanced: boolean;
}

function comboName(c: Combo): string {
  return `${c.fill}/${c.collision}`;
}

function stubFor(name: string): DurableObjectStub {
  return env.BENCH_ARENA.get(env.BENCH_ARENA.idFromName(name));
}

async function setup(stub: DurableObjectStub, combo: Combo, entities: number): Promise<void> {
  const res = await stub.fetch('https://bench/setup', {
    method: 'POST',
    body: JSON.stringify({ seed: 424242, entities, ...combo }),
  });
  if (res.status !== 200) throw new Error(`setup failed: ${String(res.status)}`);
}

async function runTicks(stub: DurableObjectStub, ticks: number): Promise<RunResult> {
  const res = await stub.fetch(`https://bench/run?ticks=${String(ticks)}`);
  if (res.status !== 200) throw new Error(`run failed: ${String(res.status)}`);
  return await res.json<RunResult>();
}

async function measure(combo: Combo, n: number): Promise<Row> {
  const stub = stubFor(`sweep-${comboName(combo)}-${String(n)}`);
  await setup(stub, combo, n);
  await runTicks(stub, WARMUP_TICKS);

  // Probe to size batches to ~100 ms wall clock each.
  const probeStart = Date.now();
  await runTicks(stub, 50);
  const estMsPerTick = Math.max((Date.now() - probeStart) / 50, 0.005);
  const ticksPerBatch = Math.min(2000, Math.max(50, Math.round(100 / estMsPerTick)));

  const perTick: number[] = [];
  let segmentChecks = 0;
  let fills = 0;
  let clockAdvanced = false;
  for (let b = 0; b < BATCHES; b++) {
    const t0 = Date.now();
    const result = await runTicks(stub, ticksPerBatch);
    perTick.push((Date.now() - t0) / ticksPerBatch);
    segmentChecks += result.stats.segmentChecks;
    fills += result.stats.fills;
    clockAdvanced = result.clockAdvanced;
  }
  perTick.sort((a, b) => a - b);
  const measuredTicks = BATCHES * ticksPerBatch;
  return {
    combo: comboName(combo),
    n,
    msPerTickAvg: perTick.reduce((s, v) => s + v, 0) / perTick.length,
    msPerTickP95: perTick[Math.min(perTick.length - 1, Math.ceil(0.95 * perTick.length) - 1)] ?? 0,
    msPerTickMax: perTick[perTick.length - 1] ?? 0,
    segChecksPerTick: segmentChecks / measuredTicks,
    fillsPerSecond: (fills / measuredTicks) * 20,
    clockAdvanced,
  };
}

function fmt(v: number, digits = 3): string {
  return v.toFixed(digits);
}

describe('DO-CPU sweep (ticket 02)', () => {
  it('measures ms/tick over N for every fill/collision combo', async () => {
    const rows: Row[] = [];
    for (const combo of COMBOS) {
      for (const n of N_LIST) {
        const row = await measure(combo, n);
        rows.push(row);
        console.log(
          `[sweep] ${row.combo} N=${String(n)} avg=${fmt(row.msPerTickAvg)}ms ` +
            `p95=${fmt(row.msPerTickP95)}ms segChecks/tick=${fmt(row.segChecksPerTick, 0)}`,
        );
      }
    }

    console.log(
      '\n| Variante | N | ms/Tick avg | ms/Tick p95 | ms/Tick max | SegChecks/Tick | Fills/s |',
    );
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) {
      console.log(
        `| ${r.combo} | ${String(r.n)} | ${fmt(r.msPerTickAvg)} | ${fmt(r.msPerTickP95)} | ` +
          `${fmt(r.msPerTickMax)} | ${fmt(r.segChecksPerTick, 0)} | ${fmt(r.fillsPerSecond, 1)} |`,
      );
    }
    console.log(
      `\n[sweep] in-DO clock advances during sync CPU: ${String(rows[0]?.clockAdvanced)}`,
    );

    for (const r of rows) {
      expect(r.msPerTickAvg).toBeGreaterThan(0);
      expect(r.segChecksPerTick).toBeGreaterThan(0);
    }
  });

  it('verifies real 20-Hz pacing at key population sizes', async () => {
    console.log('\n| Variante | N | Wall ms (soll 10000) | Lateness p50 | p95 | max |');
    console.log('|---|---|---|---|---|---|');
    for (const combo of COMBOS) {
      const list = PACED_N.get(comboName(combo));
      if (!list) continue;
      for (const n of list) {
        const stub = stubFor(`paced-${comboName(combo)}-${String(n)}`);
        await setup(stub, combo, n);
        await runTicks(stub, WARMUP_TICKS);
        const res = await stub.fetch(`https://bench/run-paced?ticks=${String(PACED_TICKS)}`);
        const data = await res.json<PacedResult>();
        console.log(
          `| ${comboName(combo)} | ${String(n)} | ${String(data.msWall)} | ` +
            `${fmt(data.latenessMsP50, 1)} | ${fmt(data.latenessMsP95, 1)} | ${fmt(data.latenessMsMax, 1)} |`,
        );
        expect(data.ticks).toBe(PACED_TICKS);
      }
    }
  });
});
