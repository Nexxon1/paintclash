/**
 * Repro harness for the territory egress of [ticket 29](../../../.scratch/paintclash/issues/29-gebiets-deltas-statt-vollbild.md):
 * a headless arena of bots painting a map full, with a byte counter around
 * every territory frame the send path would emit.
 *
 * It drives the REAL pieces — `sim-core`'s `step` and the server's `BotPilot`
 * through the same intent seam `ArenaCore` uses (ADR-0005), and the REAL
 * `encodeTerritory` for the bytes — and leaves out only the transport. That is
 * deliberate: the question is how many bytes the arena hands to each socket per
 * second, and a WebSocket does not change that number.
 *
 * The one number here that is NOT measured but assumed is the client count.
 * Territory frames are broadcast to every joined connection (`arena.ts`), so a
 * bot-only arena emits the bytes without anyone to receive them; `bytesPerSecond`
 * is therefore what ONE client would receive, and an arena's total is that times
 * its population. Ticket 24's 31 KB/s per client and 245 KB/s per arena are the
 * same number read the two ways.
 *
 * Deterministic by construction (pinned seed, bots are pure functions of the
 * state), so two runs fly the *same* path and produce the *same* byte counts —
 * unlike a stopwatch bench, everything here is reproducible to the unit.
 */

import { BotPilot, senseFor } from '@paintclash/server/bot';
import { TICK_DT_SEC, TICK_HZ, type Territory, type TurnSignal } from '@paintclash/shared';
import { createSimState, ringThickness, step, territoryArea } from '@paintclash/sim-core';

import { polyDeviationWU, simplifyTerritoryDetailed, territoryFrameBytes } from './wire.js';

export interface BandwidthRunOptions {
  /** Edge length of the square arena in WU. */
  arenaSizeWU: number;
  /** Bots painting it — spawned on tick 0 and never retired. */
  bots: number;
  /** Simulated arena time. */
  seconds: number;
  /** Pinned, so the flown path is a constant across runs. */
  seed: number;
  /**
   * RDP tolerances to price the send-path decimation at, in WU. Read against
   * `BALANCE.trail.widthWU` (1 WU) and the 10 WU grid square — a tolerance is
   * only cheap if the outline it moves stays under what a player notices.
   */
  tolerancesWU: readonly number[];
}

/** What decimating the send copy at one tolerance would cost and save. */
export interface ToleranceCost {
  epsilonWU: number;
  /** Territory bytes ONE client would receive, per simulated second. */
  bytesPerSecond: Float64Array;
  /**
   * Worst outline movement of a SURVIVING piece, in WU — the "would a player see
   * it?" number. Sampled, not exhaustive: the metric is O(V_before × V_after)
   * per piece, which over four hours of 800-vertex territories is a bigger
   * computation than the arena itself. `deviationSamples` says how many pieces
   * stand behind it.
   */
  worstDeviationWU: number;
  deviationSamples: number;
  /** Worst |relative area error| over EVERY frame — this one is cheap enough. */
  worstAreaErrorFraction: number;
  /** Mean |relative area error| over every frame carrying area. */
  meanAreaErrorFraction: number;
  /** Frames where decimation erased at least one whole piece. */
  framesLosingPieces: number;
  /**
   * Erasure EVENTS, not distinct pieces: counted per frame, and a splinter that
   * survives in a player's territory for a hundred frames is counted in each of
   * them. Read as a rate against `framesPerSecond` ("how often does a frame go
   * out with something missing"), never as "this many pieces were destroyed" —
   * stored pieces carry no identity across frames, so this bench cannot count
   * them distinctly and does not pretend to.
   */
  lostPieceEvents: number;
  /**
   * Of those, the ones above the lattice-needle floor — real geometry rather
   * than ticket 31's snap artefacts.
   *
   * This is a GUARD, not a finding, and it is expected to come out saturated
   * (equal to `lostPieceEvents`). `sim-core`'s `isLandRing` (fill.ts) already
   * refuses to store a ring thinner than `MIN_LAND_THICKNESS_WU`, and ticket 31
   * closed with "davon Nadeln: 0" — so a stored piece is real geometry by
   * construction, and decimation cannot be erasing needles because there are
   * none left to erase. The value of the column is the day it DISAGREES: that
   * would mean ticket 31's invariant has broken upstream.
   *
   * What it therefore does NOT answer is "could a player see the erased
   * piece?". That is a question of size, and the two numbers below answer it.
   */
  lostPieceEventsAboveNeedleFloor: number;
  /** The worst piece it erased — the "would anyone notice?" pair. */
  worstLostPieceAreaWU2: number;
  worstLostPieceThicknessWU: number;
}

/** One run's raw per-second record — statistics are derived, never accumulated. */
export interface BandwidthRun {
  options: BandwidthRunOptions;
  /**
   * Territory bytes ONE client would receive, per simulated second — the
   * baseline this whole bench exists to put a number on.
   */
  bytesPerSecond: Float64Array;
  /**
   * Territory frames ONE client would receive, per simulated second. This is
   * also the client's re-tessellation rate: every frame replaces a whole
   * territory, so the renderer rebuilds that plateau's mesh and recomputes its
   * carve (ticket 29's second cost, the one that is not bytes).
   */
  framesPerSecond: Int32Array;
  /** Frames by reason over the whole run — `sync` on death/spawn/steal. */
  syncFrames: number;
  fillFrames: number;
  /** Largest single frame seen, in bytes — what one fill can cost at worst. */
  peakFrameBytes: number;
  /**
   * Loop **closures**, not captures (CONTEXT.md, "Loop-Schluss ≠ Fang") — the
   * premise that the bots painted at all. Same counter as `bench/fill-budget`.
   */
  closures: number;
  deaths: number;
  tolerances: ToleranceCost[];
}

/** Per-tolerance accumulator, folded into a `ToleranceCost` at the end. */
interface ToleranceAccumulator {
  epsilonWU: number;
  bytesPerSecond: Float64Array;
  worstDeviationWU: number;
  deviationSamples: number;
  worstAreaErrorFraction: number;
  areaErrorSum: number;
  areaErrorFrames: number;
  framesLosingPieces: number;
  lostPieceEvents: number;
  lostPieceEventsAboveNeedleFloor: number;
  worstLostPieceAreaWU2: number;
  worstLostPieceThicknessWU: number;
}

/** How often the O(V²) deviation metric is sampled. Once per arena minute. */
const DEVIATION_SAMPLE_TICKS = TICK_HZ * 60;

/**
 * How thin an erased piece may be before this bench stops calling it land, in
 * WU. Same value and same calibration as `bench/fill-budget`'s needle floor —
 * see the rationale there.
 *
 * Deliberately this bench's OWN literal rather than `sim-core`'s
 * `MIN_LAND_THICKNESS_WU`, and here that matters more than usual: the column it
 * feeds exists to catch the day `isLandRing` stops holding. A guard that reads
 * the very constant it guards would move with it and go quietly green.
 */
const NEEDLE_THICKNESS_WU = 1e-4;

/**
 * Simulate `seconds` of arena time, counting the territory bytes the send path
 * would emit and pricing the same frames at each tolerance in the same pass.
 *
 * Async only to hand the event loop back once per simulated second — same
 * reasoning as `bench/fill-budget`'s harness: a worker that never yields stops
 * answering Vitest's reporter RPC, and a bench that always exits 1 is a bench
 * nobody reads. There is no stopwatch here, so the yield costs nothing but wall
 * clock.
 */
export async function runBandwidth(options: BandwidthRunOptions): Promise<BandwidthRun> {
  const { arenaSizeWU, bots, seconds, seed, tolerancesWU } = options;
  const state = createSimState(seed, arenaSizeWU);
  const pilots = new Map<number, BotPilot>();
  for (let id = 1; id <= bots; id++) pilots.set(id, new BotPilot(id));
  const ticks = Math.round(seconds * TICK_HZ);
  const bytesPerSecond = new Float64Array(seconds);
  const framesPerSecond = new Int32Array(seconds);
  const accumulators: ToleranceAccumulator[] = tolerancesWU.map((epsilonWU) => ({
    epsilonWU,
    bytesPerSecond: new Float64Array(seconds),
    worstDeviationWU: 0,
    deviationSamples: 0,
    worstAreaErrorFraction: 0,
    areaErrorSum: 0,
    areaErrorFrames: 0,
    framesLosingPieces: 0,
    lostPieceEvents: 0,
    lostPieceEventsAboveNeedleFloor: 0,
    worstLostPieceAreaWU2: 0,
    worstLostPieceThicknessWU: 0,
  }));
  let syncFrames = 0;
  let fillFrames = 0;
  let peakFrameBytes = 0;
  let closures = 0;
  let deaths = 0;
  let nextDeviationTick = 0;
  for (let t = 0; t < ticks; t++) {
    // Deliberately the same three lines as `ArenaCore.steerBots` (arena.ts) —
    // if that seam ever changes, this bench must follow, or it measures a
    // steering the arena no longer does.
    const turns: { id: number; turn: TurnSignal }[] = [];
    for (const [id, pilot] of pilots) {
      const sight = senseFor(state, id);
      if (sight) turns.push({ id, turn: pilot.steer(sight) });
    }
    // Every bot joins on tick 0 — the population rule (`ArenaCore.manageBots`)
    // is a different ticket's subject; this one wants a constant, saturating
    // load. A join is also a `sync` frame, so tick 0 costs 8 small ones.
    const spawned = t === 0 ? [...pilots.keys()] : [];
    const events = step(state, { botJoins: spawned, turns }, TICK_DT_SEC);
    closures += events.fills.length;
    deaths += events.deaths.length;

    // The send path of `ArenaCore.tick`, territory frames only: a `sync` per
    // death victim, spawn and steal victim (deduped, order preserved), then a
    // `fill` per loop closure. Every one of them carries that player's WHOLE
    // territory and goes to EVERY joined connection — which is the line this
    // ticket is about.
    //
    // Deliberately the same shape as that `eventFrames` block — if THAT seam
    // ever changes, this bench must follow, or it prices a send path the arena
    // no longer has. The one frame not modelled is the joiner's one-off world
    // sync (`handleFrame`, on `join`): once per connection against ~8 per
    // second, it cannot move a steady-state rate.
    const syncIds = new Set([
      ...events.deaths.map((d) => d.victimId),
      ...spawned,
      ...events.steals,
    ]);
    const sent: Territory[] = [];
    for (const id of syncIds) {
      const p = state.players.find((q) => q.id === id);
      if (p) {
        sent.push(p.territory);
        syncFrames += 1;
      }
    }
    for (const id of events.fills) {
      const p = state.players.find((q) => q.id === id);
      if (p) {
        sent.push(p.territory);
        fillFrames += 1;
      }
    }

    const second = Math.min(seconds - 1, Math.floor(t / TICK_HZ));
    const sampleDeviation = sent.length > 0 && t >= nextDeviationTick;
    if (sampleDeviation) nextDeviationTick = t + DEVIATION_SAMPLE_TICKS;
    for (const territory of sent) {
      const bytes = territoryFrameBytes(territory);
      bytesPerSecond[second] = (bytesPerSecond[second] ?? 0) + bytes;
      framesPerSecond[second] = (framesPerSecond[second] ?? 0) + 1;
      peakFrameBytes = Math.max(peakFrameBytes, bytes);
      const area = territoryArea(territory);
      for (const acc of accumulators) {
        const { simplified, kept, lost } = simplifyTerritoryDetailed(territory, acc.epsilonWU);
        acc.bytesPerSecond[second] =
          (acc.bytesPerSecond[second] ?? 0) + territoryFrameBytes(simplified);
        if (area > 0) {
          const error = Math.abs(territoryArea(simplified) - area) / area;
          acc.worstAreaErrorFraction = Math.max(acc.worstAreaErrorFraction, error);
          acc.areaErrorSum += error;
          acc.areaErrorFrames += 1;
        }
        // What the tolerance ERASED, sized so a needle and a piece of land do
        // not read as the same event.
        if (lost.length > 0) acc.framesLosingPieces += 1;
        acc.lostPieceEvents += lost.length;
        for (const poly of lost) {
          const outer = poly[0];
          const thickness = outer === undefined ? 0 : ringThickness(outer);
          if (thickness >= NEEDLE_THICKNESS_WU) acc.lostPieceEventsAboveNeedleFloor += 1;
          acc.worstLostPieceThicknessWU = Math.max(acc.worstLostPieceThicknessWU, thickness);
          acc.worstLostPieceAreaWU2 = Math.max(acc.worstLostPieceAreaWU2, territoryArea([poly]));
        }
        // What it MOVED, per surviving piece against its own simplified self.
        if (sampleDeviation) {
          for (const pair of kept) {
            acc.worstDeviationWU = Math.max(
              acc.worstDeviationWU,
              polyDeviationWU(pair.before, pair.after),
            );
            acc.deviationSamples += 1;
          }
        }
      }
    }
    if (t % TICK_HZ === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    options,
    bytesPerSecond,
    framesPerSecond,
    syncFrames,
    fillFrames,
    peakFrameBytes,
    closures,
    deaths,
    tolerances: accumulators.map((acc) => ({
      epsilonWU: acc.epsilonWU,
      bytesPerSecond: acc.bytesPerSecond,
      worstDeviationWU: acc.worstDeviationWU,
      deviationSamples: acc.deviationSamples,
      worstAreaErrorFraction: acc.worstAreaErrorFraction,
      meanAreaErrorFraction: acc.areaErrorFrames === 0 ? 0 : acc.areaErrorSum / acc.areaErrorFrames,
      framesLosingPieces: acc.framesLosingPieces,
      lostPieceEvents: acc.lostPieceEvents,
      lostPieceEventsAboveNeedleFloor: acc.lostPieceEventsAboveNeedleFloor,
      worstLostPieceAreaWU2: acc.worstLostPieceAreaWU2,
      worstLostPieceThicknessWU: acc.worstLostPieceThicknessWU,
    })),
  };
}

/**
 * How far a per-second series still moves between the two halves of its
 * post-settle tail — the question "did this run reach the plateau, or is it
 * still filling up?".
 *
 * The same arithmetic as `bench/fill-budget`'s `saturationOf`, and it is here
 * for the same reason: an egress mean taken from the ramp describes an arena
 * filling up, not the one players spend their time in. Kept in this package
 * rather than imported, because each bench owns its harness (`carve-budget` and
 * `fill-budget` both duplicate the arena loop for the same reason) — and read
 * with the same warning: a half-window must be several sawtooth periods wide or
 * it measures the phase it happened to land in.
 */
export interface Plateau {
  /**
   * Seconds each half covers. 0 when the run ends inside the settle time —
   * check this before trusting `driftFraction`, which is 0 in that case too.
   */
  halfWindowSec: number;
  earlyMean: number;
  lateMean: number;
  /**
   * `(late − early) / early`: ~0 at equilibrium, clearly > 0 while growing.
   *
   * Also 0 for the two runs this cannot judge — no comparable window, and an
   * arena that emitted nothing — so "0" alone never means "plateau reached".
   */
  driftFraction: number;
}

/** A per-second record: bytes as `Float64Array`, frame counts as `Int32Array`. */
export type Series = readonly number[] | Float64Array | Int32Array;

export function plateauOf(series: Series, settleSec: number): Plateau {
  const tail = Math.max(0, series.length - settleSec);
  const halfWindowSec = Math.floor(tail / 2);
  if (halfWindowSec === 0) {
    return { halfWindowSec: 0, earlyMean: 0, lateMean: 0, driftFraction: 0 };
  }
  const meanFrom = (start: number): number => {
    let sum = 0;
    for (let i = start; i < start + halfWindowSec; i++) sum += series[i] ?? 0;
    return sum / halfWindowSec;
  };
  // An odd tail drops its middle second, so both halves are the same width.
  const earlyMean = meanFrom(settleSec);
  const lateMean = meanFrom(series.length - halfWindowSec);
  return {
    halfWindowSec,
    earlyMean,
    lateMean,
    driftFraction: earlyMean === 0 ? 0 : (lateMean - earlyMean) / earlyMean,
  };
}

/** Mean of a per-second series over the seconds after `settleSec`. */
export function meanAfter(series: Series, settleSec: number): number {
  let sum = 0;
  let n = 0;
  for (let i = settleSec; i < series.length; i++) {
    sum += series[i] ?? 0;
    n += 1;
  }
  return n === 0 ? 0 : sum / n;
}

/** `(baseline − measured) / baseline` as a saving factor: 2 means half the bytes. */
export function savingFactor(baseline: number, measured: number): number {
  if (measured === 0) return baseline === 0 ? 1 : Infinity;
  return baseline / measured;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The run as the two questions ticket 29 asks: what does the full-territory
 * send path cost today, and what would decimating it save.
 */
export function report(run: BandwidthRun, settleSec: number): string {
  const { arenaSizeWU, bots, seconds, seed } = run.options;
  const baseline = meanAfter(run.bytesPerSecond, settleSec);
  const frames = meanAfter(run.framesPerSecond, settleSec);
  const plateau = plateauOf(run.bytesPerSecond, settleSec);
  const lines = [
    `${String(arenaSizeWU)} WU · ${String(bots)} bots · ${String(seconds)} s ` +
      `(seed ${String(seed)}), measured after a ${String(settleSec)} s settle`,
    `  per client: ${kb(baseline)}/s · ${frames.toFixed(2)} territory frames/s ` +
      `· peak frame ${kb(run.peakFrameBytes)}`,
    `  per client and hour: ${((baseline * 3600) / 1024 / 1024).toFixed(0)} MB`,
    // Scaled by the ENTITY count, because that is the only population this
    // bot-only arena has. It is the "if every painter were a human" reading —
    // in the production default (1 human + 7 bots) the arena total equals the
    // per-client figure above, because bots hold no socket.
    `  per arena IF all ${String(bots)} painters were human sockets: ` +
      `${kb(baseline * bots)}/s · ` +
      `${((baseline * bots * 3600) / 1024 / 1024 / 1024).toFixed(2)} GB/h`,
    `  frames: ${String(run.fillFrames)} fill · ${String(run.syncFrames)} sync ` +
      `· ${String(run.closures)} closures · ${String(run.deaths)} deaths ` +
      `(whole-run counts, unlike the post-settle rates above)`,
    `  mean frame ${kb(baseline / Math.max(1e-9, frames))} over the measured window`,
    `  plateau (2 × ${String(plateau.halfWindowSec)} s): ${kb(plateau.earlyMean)}/s → ` +
      `${kb(plateau.lateMean)}/s (${(plateau.driftFraction * 100).toFixed(1)} %)`,
    '',
    '  what it saves, and how far it moves an outline it keeps:',
    '  tolerance   bytes/s/client   saving   area err (worst/mean)   worst outline dev',
  ];
  for (const tolerance of run.tolerances) {
    const measured = meanAfter(tolerance.bytesPerSecond, settleSec);
    lines.push(
      `  ${tolerance.epsilonWU.toFixed(2).padStart(6)} WU  ` +
        `${kb(measured).padStart(13)}  ` +
        `${savingFactor(baseline, measured).toFixed(2).padStart(6)}×  ` +
        `${(tolerance.worstAreaErrorFraction * 100).toFixed(2).padStart(9)} % / ` +
        `${(tolerance.meanAreaErrorFraction * 100).toFixed(2).padStart(5)} %  ` +
        `${tolerance.worstDeviationWU.toFixed(4).padStart(13)} WU`,
    );
  }
  const samples = run.tolerances[0]?.deviationSamples ?? 0;
  lines.push(
    `  (outline deviation from ${String(samples)} sampled pieces, once per arena minute)`,
    '',
    '  and what it ERASES. "erasures" counts frame×piece EVENTS, not distinct',
    '  pieces — a splinter present for a hundred frames counts in each. The',
    `  "not needles" column is a guard on ticket 31's invariant (floor ` +
      `${NEEDLE_THICKNESS_WU.toExponential(0)} WU) and is`,
    '  EXPECTED to equal the first: sim-core stores no needles to erase.',
    '  tolerance   erasures   per frame   not needles   worst lost: thickness / area',
  );
  const totalFrames = run.fillFrames + run.syncFrames;
  for (const tolerance of run.tolerances) {
    lines.push(
      `  ${tolerance.epsilonWU.toFixed(2).padStart(6)} WU  ` +
        `${String(tolerance.lostPieceEvents).padStart(8)}  ` +
        `${(tolerance.lostPieceEvents / Math.max(1, totalFrames)).toFixed(3).padStart(9)}  ` +
        `${String(tolerance.lostPieceEventsAboveNeedleFloor).padStart(11)}  ` +
        `${tolerance.worstLostPieceThicknessWU.toExponential(2).padStart(12)} WU / ` +
        `${tolerance.worstLostPieceAreaWU2.toExponential(2)} WU²`,
    );
  }
  return lines.join('\n');
}
