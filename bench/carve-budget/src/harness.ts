/**
 * Repro harness for the client-side plateau carve (ticket 25): a headless
 * arena of bots painting a map full, with a stopwatch around the carve work
 * ONE browser frame does.
 *
 * It drives the real pieces — `sim-core`'s `step` and the server's `BotPilot`
 * for the geometry, and the client's own `PlateauCarver` for the carve — and
 * replays `ArenaScene.updateTerritories`' carve half against them, throttle
 * and all. What it leaves out is three.js and the GL upload: the frame that
 * froze in production was blocked inside the polygon clipper (CPU profile of
 * the deployed build, ticket 25), and that arithmetic is the same in node.
 *
 * Deterministic by construction (pinned seed, bots are pure functions of the
 * state), like `../fill-budget`: two runs fly the same path and only the
 * stopwatch differs.
 */

import {
  boundsOverlap,
  CARVE_THROTTLE_MS,
  CARVE_WIDTH_WU,
  PlateauCarver,
  pointsBounds,
  territoryBounds,
  type CarveInput,
} from '@paintclash/client/render/carve';
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
 * The frame budget in ms: 60 Hz. A carve costing more than this drops the
 * frame it runs in; costing hundreds of ms, it reads as a freeze — which is
 * exactly what the deployed build did (ticket 25).
 */
export const FRAME_BUDGET_MS = 1000 / 60;

/** What one plateau's carve state looks like on the client (`ArenaScene`). */
interface PlateauEntry {
  carver: PlateauCarver;
  /** The territory reference the carver was reset to — the client's `rev`. */
  rev: Territory;
  /** Simulated `performance.now()` of the last carve update (throttling). */
  carveCheckedAt: number;
  /** The carver output the mesh was last built from. */
  builtFrom: Territory;
}

export interface CarveRunOptions {
  arenaSizeWU: number;
  bots: number;
  seconds: number;
  seed: number;
}

export interface CarveRun {
  options: CarveRunOptions;
  /** Carve cost of one rendered frame, in ms — every plateau together. */
  frameMs: Float64Array;
  /** The most expensive SINGLE plateau update in each frame, in ms. */
  worstUpdateMs: Float64Array;
  /** Mesh rebuilds triggered per frame (the carve output moved). */
  rebuilds: Int32Array;
  /** Total territory vertices, sampled once per simulated second. */
  verticesPerSecond: Int32Array;
  /**
   * Updates whose result is no longer the raw plateau — a groove really was
   * cut. THE premise number: every other counter here also moves in an arena
   * where nothing ever crosses foreign land (a plateau is rebuilt on every
   * fill, and the throttle bookkeeping costs time either way), so only this
   * one can tell a carve bench from an empty stopwatch.
   */
  carves: number;
}

/**
 * Simulate `seconds` of arena time and, once per tick, do the carve work a
 * browser frame would. Once per tick is the client's real ceiling: the scene
 * throttles each plateau to one carve per `CARVE_THROTTLE_MS` (50 ms = one
 * tick), so a 60 Hz client carves at most this often, however many frames it
 * draws in between.
 */
export function runCarveLoad(options: CarveRunOptions): CarveRun {
  const { arenaSizeWU, bots, seconds, seed } = options;
  const state = createSimState(seed, arenaSizeWU);
  const pilots = new Map<number, BotPilot>();
  for (let id = 1; id <= bots; id++) pilots.set(id, new BotPilot(id));
  const ticks = Math.round(seconds * TICK_HZ);
  const frameMs = new Float64Array(ticks);
  const worstUpdateMs = new Float64Array(ticks);
  const rebuilds = new Int32Array(ticks);
  const verticesPerSecond = new Int32Array(seconds);
  const plateaus = new Map<number, PlateauEntry>();
  let carves = 0;
  for (let t = 0; t < ticks; t++) {
    const turns: { id: number; turn: TurnSignal }[] = [];
    for (const [id, pilot] of pilots) {
      const sight = senseFor(state, id);
      if (sight) turns.push({ id, turn: pilot.steer(sight) });
    }
    step(state, { botJoins: t === 0 ? [...pilots.keys()] : [], turns }, TICK_DT_SEC);
    // The client's clock, in simulated time — one tick per rendered carve.
    const now = t * TICK_DT_MS;
    const trails = state.players
      .filter((p) => p.trail.length > 1)
      .map((p): CarveInput => ({ playerId: p.id, points: p.trail }));
    const trailBounds = trails.map((trail) => ({ trail, bounds: pointsBounds(trail.points) }));
    let frameTotal = 0;
    let worst = 0;
    for (const player of state.players) {
      const territory = player.territory;
      if (territory.length === 0) continue;
      // Same band selection as `ArenaScene.updateTerritories`: only OTHER
      // players' trails carve, and only those that come near this plateau.
      const viewBounds = territoryBounds(territory);
      const bands: CarveInput[] = [];
      for (const { trail, bounds } of trailBounds) {
        if (trail.playerId === player.id || !bounds || !viewBounds) continue;
        if (!boundsOverlap(bounds, viewBounds, CARVE_WIDTH_WU / 2)) continue;
        bands.push(trail);
      }
      let entry = plateaus.get(player.id);
      // The client bumps `rev` on every territory message; the sim REPLACES
      // the array on exactly those events (fill, steal, spawn).
      const revChanged = entry?.rev !== territory;
      const carver = entry?.carver ?? new PlateauCarver();
      const start = performance.now();
      if (revChanged) carver.reset(territory);
      let target = entry?.builtFrom ?? territory;
      // Deliberately the same condition as `ArenaScene.updateTerritories` —
      // if that seam ever changes, this bench must follow, or it measures a
      // carve cadence the client no longer runs.
      if (entry === undefined || revChanged || now - entry.carveCheckedAt >= CARVE_THROTTLE_MS) {
        target = carver.update(bands);
        if (entry) entry.carveCheckedAt = now;
      }
      const cost = performance.now() - start;
      frameTotal += cost;
      worst = Math.max(worst, cost);
      // `PlateauCarver` hands back the untouched base until a quad actually
      // clips it, so a moved reference is proof a groove was cut.
      if (target !== territory) carves += 1;
      if (entry === undefined || revChanged || target !== entry.builtFrom) {
        rebuilds[t] = (rebuilds[t] ?? 0) + 1;
        entry = { carver, rev: territory, carveCheckedAt: now, builtFrom: target };
        plateaus.set(player.id, entry);
      }
    }
    for (const id of [...plateaus.keys()]) {
      if (!state.players.some((p) => p.id === id)) plateaus.delete(id);
    }
    frameMs[t] = frameTotal;
    worstUpdateMs[t] = worst;
    if (t % TICK_HZ === 0) {
      const second = t / TICK_HZ;
      if (second < seconds) {
        let vertices = 0;
        for (const p of state.players) {
          for (const poly of p.territory) for (const ring of poly) vertices += ring.length;
        }
        verticesPerSecond[second] = vertices;
      }
    }
  }
  return { options, frameMs, worstUpdateMs, rebuilds, verticesPerSecond, carves };
}

export interface CarveStats {
  meanMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  maxTick: number;
  /** Frames whose carve alone costs more than the 60 Hz frame. */
  overBudget: number;
  /** First frame over budget, or -1. */
  firstOverTick: number;
  /** Frames costing more than a fifth of a second — a visible freeze. */
  freezes: number;
  peakVertices: number;
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** A carve this long is not a dropped frame any more, it is a freeze. */
export const FREEZE_MS = 200;

export function statsOf(run: CarveRun): CarveStats {
  const { frameMs } = run;
  let sum = 0;
  let maxMs = 0;
  let maxTick = 0;
  let overBudget = 0;
  let firstOverTick = -1;
  let freezes = 0;
  for (let t = 0; t < frameMs.length; t++) {
    const ms = frameMs[t] ?? 0;
    sum += ms;
    if (ms > maxMs) {
      maxMs = ms;
      maxTick = t;
    }
    if (ms >= FRAME_BUDGET_MS) {
      overBudget += 1;
      if (firstOverTick === -1) firstOverTick = t;
    }
    if (ms >= FREEZE_MS) freezes += 1;
  }
  const sorted = Float64Array.from(frameMs).sort();
  let peakVertices = 0;
  for (const v of run.verticesPerSecond) peakVertices = Math.max(peakVertices, v);
  return {
    meanMs: frameMs.length === 0 ? 0 : sum / frameMs.length,
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    maxMs,
    maxTick,
    overBudget,
    firstOverTick,
    freezes,
    peakVertices,
  };
}

/** Mean/max per `windowSec`-wide slice — the curve, not just its summary. */
export function profile(run: CarveRun, windowSec: number): string[] {
  const perWindow = windowSec * TICK_HZ;
  const lines: string[] = [];
  for (let start = 0; start < run.frameMs.length; start += perWindow) {
    let sum = 0;
    let max = 0;
    let n = 0;
    let rebuilds = 0;
    for (let t = start; t < Math.min(start + perWindow, run.frameMs.length); t++) {
      const ms = run.frameMs[t] ?? 0;
      sum += ms;
      max = Math.max(max, ms);
      rebuilds += run.rebuilds[t] ?? 0;
      n += 1;
    }
    const second = Math.floor(start / TICK_HZ);
    lines.push(
      `  t=${String(second).padStart(4)}s  mean ${(sum / Math.max(1, n)).toFixed(2).padStart(7)} ms` +
        `  max ${max.toFixed(2).padStart(8)} ms  rebuilds ${String(rebuilds).padStart(5)}` +
        `  vertices ${String(run.verticesPerSecond[second] ?? 0).padStart(6)}`,
    );
  }
  return lines;
}

export function report(run: CarveRun, stats: CarveStats): string {
  const { arenaSizeWU, bots, seconds } = run.options;
  const lines = [
    `${String(arenaSizeWU)} WU · ${String(bots)} bots · ${String(seconds)} s ` +
      `(seed ${String(run.options.seed)})`,
    `  carve per frame: mean ${stats.meanMs.toFixed(2)} ms · p95 ${stats.p95Ms.toFixed(2)} ms · ` +
      `p99 ${stats.p99Ms.toFixed(2)} ms · max ${stats.maxMs.toFixed(2)} ms ` +
      `(t=${(stats.maxTick / TICK_HZ).toFixed(1)} s)`,
    `  over ${FRAME_BUDGET_MS.toFixed(1)} ms: ${String(stats.overBudget)} frames` +
      (stats.firstOverTick === -1
        ? ''
        : `, first at t=${(stats.firstOverTick / TICK_HZ).toFixed(1)} s`) +
      ` · over ${String(FREEZE_MS)} ms (freeze): ${String(stats.freezes)}`,
    `  peak vertices ${String(stats.peakVertices)}`,
  ];
  return [...lines, ...profile(run, 30)].join('\n');
}
