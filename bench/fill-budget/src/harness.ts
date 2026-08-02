/**
 * Repro harness for the fill cost (ticket 22): a headless arena of bots
 * painting a map full, with a stopwatch around every tick.
 *
 * It drives the REAL pieces — `sim-core`'s `step` and the server's `BotPilot`
 * through the same intent seam `ArenaCore` uses (ADR-0005) — and leaves out
 * only the transport. That is the whole point: the synthetic load of
 * `bench/do-cpu` modelled the fill as a sweep over 64-vertex rings and
 * concluded it was CPU-neutral; against real code the fill is ~99 % of the
 * tick, because real territories are never decimated to 64 vertices.
 *
 * Deterministic by construction (pinned seed, bots are pure functions of the
 * state), so two runs fly the *same* path and only the stopwatch differs —
 * the same rule the scenario suite lives by.
 */

import { BotPilot, senseFor } from '@paintclash/server/bot';
import {
  TICK_DT_MS,
  TICK_DT_SEC,
  TICK_HZ,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import { createSimState, step } from '@paintclash/sim-core';

/**
 * The tick budget in ms: one 20 Hz timestep. A tick costing more than the
 * timestep it advances cannot keep up, and `arena-do.ts` re-anchors its
 * schedule instead of catching up — so a sustained overrun reads as a frozen
 * world for everyone in the arena, not as a stutter for one player.
 */
export const TICK_BUDGET_MS = TICK_DT_MS;

/**
 * How much slower to assume the DO's shared vCPU is than this dev machine.
 * Same factor the ticket-02 benchmark interprets its numbers with — carried
 * here so a local "well under budget" is not read as production headroom it
 * has not earned. Informational: the gate below is on measured ms.
 */
export const DO_HARDWARE_FACTOR = 4;

export interface ArenaRunOptions {
  /** Edge length of the square arena in WU. */
  arenaSizeWU: number;
  /** Bots painting it — spawned on tick 0 and never retired. */
  bots: number;
  /** Simulated arena time. */
  seconds: number;
  /** Pinned, so the flown path is a constant across runs. */
  seed: number;
}

/** One run's raw per-tick record — statistics are derived, never accumulated. */
export interface ArenaRun {
  options: ArenaRunOptions;
  /** Steer + step, per tick, in ms — what the DO actually spends. */
  tickMs: Float64Array;
  /** The pilots' share of it, per tick, in ms. */
  steerMs: Float64Array;
  /** Total territory vertices, sampled once per simulated second. */
  verticesPerSecond: Int32Array;
  fills: number;
  deaths: number;
}

/** Total vertices across every ring of every territory — the cost driver. */
export function totalVertices(territories: readonly Territory[]): number {
  let total = 0;
  for (const territory of territories) {
    for (const poly of territory) {
      for (const ring of poly) total += ring.length;
    }
  }
  return total;
}

/** Simulate `seconds` of arena time, timing every tick. */
export function runArena(options: ArenaRunOptions): ArenaRun {
  const { arenaSizeWU, bots, seconds, seed } = options;
  const state = createSimState(seed, arenaSizeWU);
  const pilots = new Map<number, BotPilot>();
  for (let id = 1; id <= bots; id++) pilots.set(id, new BotPilot(id));
  const ticks = Math.round(seconds * TICK_HZ);
  const tickMs = new Float64Array(ticks);
  const steerMs = new Float64Array(ticks);
  const verticesPerSecond = new Int32Array(seconds);
  let fills = 0;
  let deaths = 0;
  for (let t = 0; t < ticks; t++) {
    const start = performance.now();
    // Deliberately the same three lines as `ArenaCore.steerBots` (arena.ts) —
    // if that seam ever changes, this bench must follow, or it measures a
    // steering the arena no longer does.
    const turns: { id: number; turn: TurnSignal }[] = [];
    for (const [id, pilot] of pilots) {
      const sight = senseFor(state, id);
      if (sight) turns.push({ id, turn: pilot.steer(sight) });
    }
    const steered = performance.now();
    // Every bot joins on tick 0 — the population rule (`ArenaCore.manageBots`)
    // is a different ticket's subject; this one wants a constant, saturating
    // load.
    const events = step(state, { botJoins: t === 0 ? [...pilots.keys()] : [], turns }, TICK_DT_SEC);
    const done = performance.now();
    tickMs[t] = done - start;
    steerMs[t] = steered - start;
    fills += events.fills.length;
    deaths += events.deaths.length;
    // Outside the stopwatch, once a second: walking every ring is cheap
    // against a fill, but not against a quiet tick.
    if (t % TICK_HZ === 0) {
      const second = t / TICK_HZ;
      if (second < seconds) {
        verticesPerSecond[second] = totalVertices(state.players.map((p) => p.territory));
      }
    }
  }
  return { options, tickMs, steerMs, verticesPerSecond, fills, deaths };
}

/**
 * How far the vertex count still moves between the two halves of a run's
 * post-ramp tail — the question "did this run reach the plateau, or is it
 * still filling up?".
 */
export interface Saturation {
  /**
   * Seconds each half covers. 0 when the run ends inside the settle time —
   * check this before trusting `driftFraction`, which is 0 in that case too.
   */
  halfWindowSec: number;
  earlyMeanVertices: number;
  lateMeanVertices: number;
  /**
   * `(late − early) / early`: ~0 at equilibrium, clearly > 0 while growing.
   *
   * Also 0 for the two runs this cannot judge — no comparable window, and an
   * arena that painted nothing — so "0" alone never means "plateau reached".
   */
  driftFraction: number;
}

/**
 * Split a run's per-second vertex series after `settleSec` and compare its two
 * halves — ticket 23's equilibrium table (6 592 → 6 473, −1,8 %) as a function.
 *
 * The steady-state measurement below stands or falls on this: a 30-minute run
 * that never got out of the ramp yields tick costs from the *filling up*, not
 * from the plateau, and reading them as a baseline would understate it.
 */
export function saturationOf(
  verticesPerSecond: readonly number[] | Int32Array,
  settleSec: number,
): Saturation {
  const tail = Math.max(0, verticesPerSecond.length - settleSec);
  const halfWindowSec = Math.floor(tail / 2);
  const empty = {
    halfWindowSec: 0,
    earlyMeanVertices: 0,
    lateMeanVertices: 0,
    driftFraction: 0,
  };
  if (halfWindowSec === 0) return empty;
  const meanFrom = (start: number): number => {
    let sum = 0;
    for (let i = start; i < start + halfWindowSec; i++) sum += verticesPerSecond[i] ?? 0;
    return sum / halfWindowSec;
  };
  // An odd tail drops its middle second, so both halves are the same width.
  const earlyMeanVertices = meanFrom(settleSec);
  const lateMeanVertices = meanFrom(verticesPerSecond.length - halfWindowSec);
  return {
    halfWindowSec,
    earlyMeanVertices,
    lateMeanVertices,
    // An arena that painted nothing is trivially drift-free; that the bots
    // painted at all is a separate premise (`fills`, `peakVertices`).
    driftFraction:
      earlyMeanVertices === 0 ? 0 : (lateMeanVertices - earlyMeanVertices) / earlyMeanVertices,
  };
}

export interface RunStats {
  meanMs: number;
  p50Ms: number;
  /** The quantile ticket 02's criterion is stated in (p95 ≤ 25 ms incl. ×4). */
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Tick the maximum fell on — with `seconds`, where in the run it happened. */
  maxTick: number;
  /** Ticks at or over `TICK_BUDGET_MS`. */
  overBudget: number;
  /** First tick over budget, or -1 — the "how long until it breaks" number. */
  firstOverTick: number;
  /** Peak total territory vertices over the run. */
  peakVertices: number;
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? 0;
}

export function statsOf(run: ArenaRun): RunStats {
  const { tickMs } = run;
  let sum = 0;
  let maxMs = 0;
  let maxTick = 0;
  let overBudget = 0;
  let firstOverTick = -1;
  for (let t = 0; t < tickMs.length; t++) {
    const ms = tickMs[t] ?? 0;
    sum += ms;
    if (ms > maxMs) {
      maxMs = ms;
      maxTick = t;
    }
    if (ms >= TICK_BUDGET_MS) {
      overBudget += 1;
      if (firstOverTick === -1) firstOverTick = t;
    }
  }
  const sorted = Float64Array.from(tickMs).sort();
  let peakVertices = 0;
  for (const v of run.verticesPerSecond) peakVertices = Math.max(peakVertices, v);
  return {
    meanMs: tickMs.length === 0 ? 0 : sum / tickMs.length,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    maxMs,
    maxTick,
    overBudget,
    firstOverTick,
    peakVertices,
  };
}

/** Mean/max per `windowSec`-wide slice — the curve, not just its summary. */
export function profile(run: ArenaRun, windowSec: number): string[] {
  const perWindow = windowSec * TICK_HZ;
  const lines: string[] = [];
  for (let start = 0; start < run.tickMs.length; start += perWindow) {
    let sum = 0;
    let max = 0;
    let n = 0;
    for (let t = start; t < Math.min(start + perWindow, run.tickMs.length); t++) {
      const ms = run.tickMs[t] ?? 0;
      sum += ms;
      max = Math.max(max, ms);
      n += 1;
    }
    const second = Math.floor(start / TICK_HZ);
    const vertices = run.verticesPerSecond[second] ?? 0;
    lines.push(
      `  t=${String(second).padStart(4)}s  mean ${(sum / Math.max(1, n)).toFixed(2).padStart(7)} ms` +
        `  max ${max.toFixed(2).padStart(7)} ms  vertices ${String(vertices).padStart(6)}`,
    );
  }
  return lines;
}

export function report(run: ArenaRun, stats: RunStats): string {
  const { arenaSizeWU, bots, seconds } = run.options;
  const lines = [
    `${String(arenaSizeWU)} WU · ${String(bots)} bots · ${String(seconds)} s ` +
      `(seed ${String(run.options.seed)})`,
    `  mean ${stats.meanMs.toFixed(2)} ms · p50 ${stats.p50Ms.toFixed(2)} ms · ` +
      `p95 ${stats.p95Ms.toFixed(2)} ms · p99 ${stats.p99Ms.toFixed(2)} ms · ` +
      `max ${stats.maxMs.toFixed(2)} ms ` +
      `(tick ${String(stats.maxTick)}, t=${(stats.maxTick / TICK_HZ).toFixed(1)} s)`,
    `  over ${String(TICK_BUDGET_MS)} ms: ${String(stats.overBudget)} ticks` +
      (stats.firstOverTick === -1
        ? ''
        : `, first at t=${(stats.firstOverTick / TICK_HZ).toFixed(1)} s`),
    `  peak vertices ${String(stats.peakVertices)} · ${String(run.fills)} fills · ` +
      `${String(run.deaths)} deaths`,
    `  DO-derated (×${String(DO_HARDWARE_FACTOR)}): ` +
      `p95 ${(stats.p95Ms * DO_HARDWARE_FACTOR).toFixed(2)} ms · ` +
      `max ${(stats.maxMs * DO_HARDWARE_FACTOR).toFixed(2)} ms ` +
      `of the ${String(TICK_BUDGET_MS)} ms budget`,
  ];
  return [...lines, ...profile(run, 30)].join('\n');
}
