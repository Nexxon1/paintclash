/**
 * Benchmark Worker + Durable Object (build ticket 02).
 *
 * `BenchArena` hosts the synthetic Arena load inside a *real* DO — the same
 * single-threaded runtime the production Arena-DO will run in (ADR-0001/0004).
 * Driven by the vitest-pool-workers tests; also `wrangler dev`-able for a
 * hand-driven run against real Cloudflare infrastructure (ticket 16 re-runs
 * this against the actual build).
 *
 * Endpoints (all on the DO):
 * - POST /setup            body: LoadOptions            -> creates the world
 * - GET  /run?ticks=N      back-to-back ticks           -> RunResult
 * - GET  /run-paced?ticks=N  real 20-Hz pacing          -> PacedResult
 *
 * Timing caveat: workerd freezes `Date.now()` during synchronous CPU work in
 * production (Spectre hardening). `clockAdvanced` reports whether in-DO
 * timing is trustworthy here; the sweep additionally times every batch from
 * *outside* the DO across the fetch boundary, which is always valid.
 */

import type { LoadOptions, TickStats } from './load.js';
import { TICK_HZ, createWorld, runTick, type BenchWorld } from './load.js';

const TICK_MS = 1000 / TICK_HZ;

export interface RunResult {
  ticks: number;
  /** In-DO wall-clock ms for the batch; 0 when the runtime freezes clocks. */
  msInternal: number;
  /** Whether `Date.now()` advances during synchronous CPU work here. */
  clockAdvanced: boolean;
  stats: TickStats;
}

export interface PacedResult {
  ticks: number;
  /** Wall-clock ms for the whole paced batch (valid: awaits advance clocks). */
  msWall: number;
  /** How late each tick fired vs. its 50-ms schedule. */
  latenessMsP50: number;
  latenessMsP95: number;
  latenessMsMax: number;
}

function emptyStats(): TickStats {
  return { segmentChecks: 0, hits: 0, fills: 0, filledCells: 0, clipOps: 0, snapshotBytes: 0 };
}

function addStats(into: TickStats, s: TickStats): void {
  into.segmentChecks += s.segmentChecks;
  into.hits += s.hits;
  into.fills += s.fills;
  into.filledCells += s.filledCells;
  into.clipOps += s.clipOps;
  into.snapshotBytes += s.snapshotBytes;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** Does `Date.now()` move while we burn CPU synchronously? (See caveat above.) */
function probeClockAdvance(): boolean {
  const t0 = Date.now();
  let sink = 0;
  for (let i = 0; i < 2_000_000; i++) sink += Math.sqrt(i);
  // `sink` must escape, otherwise the loop is dead code.
  return Date.now() - t0 + (sink > 0 ? 0 : 1) > 0;
}

export class BenchArena {
  private world: BenchWorld | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/setup') {
      const opts = await request.json<LoadOptions>();
      this.world = createWorld(opts);
      return Response.json({ ok: true, entities: opts.entities });
    }
    if (!this.world) {
      return Response.json({ error: 'call /setup first' }, { status: 409 });
    }
    const ticks = Number(url.searchParams.get('ticks') ?? '0');
    if (!Number.isInteger(ticks) || ticks < 1) {
      return Response.json({ error: 'ticks must be a positive integer' }, { status: 400 });
    }
    if (url.pathname === '/run') {
      return Response.json(this.runBatch(this.world, ticks));
    }
    if (url.pathname === '/run-paced') {
      return Response.json(await this.runPaced(this.world, ticks));
    }
    return Response.json({ error: 'unknown endpoint' }, { status: 404 });
  }

  /** Back-to-back ticks: raw CPU cost, no pacing. */
  private runBatch(world: BenchWorld, ticks: number): RunResult {
    const stats = emptyStats();
    const clockAdvanced = probeClockAdvance();
    const t0 = Date.now();
    for (let t = 0; t < ticks; t++) addStats(stats, runTick(world));
    return { ticks, msInternal: Date.now() - t0, clockAdvanced, stats };
  }

  /** Real 20-Hz pacing via setTimeout — measures schedule slip under load. */
  private async runPaced(world: BenchWorld, ticks: number): Promise<PacedResult> {
    const lateness: number[] = [];
    const start = Date.now();
    let scheduled = start;
    for (let t = 0; t < ticks; t++) {
      scheduled += TICK_MS;
      const delay = Math.max(0, scheduled - Date.now());
      await new Promise((resolve) => setTimeout(resolve, delay));
      lateness.push(Math.max(0, Date.now() - scheduled));
      runTick(world);
    }
    // One final await so the last tick's CPU time lands in msWall even on a
    // clock-freezing runtime.
    await new Promise((resolve) => setTimeout(resolve, 0));
    lateness.sort((a, b) => a - b);
    return {
      ticks,
      msWall: Date.now() - start,
      latenessMsP50: percentile(lateness, 50),
      latenessMsP95: percentile(lateness, 95),
      latenessMsMax: lateness[lateness.length - 1] ?? 0,
    };
  }
}

interface Env {
  readonly BENCH_ARENA: DurableObjectNamespace;
}

/** `wrangler dev` entry: forwards everything to one fixed BenchArena. */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.BENCH_ARENA.get(env.BENCH_ARENA.idFromName('bench'));
    return stub.fetch(request);
  },
};
