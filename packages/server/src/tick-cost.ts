/**
 * What one arena tick costs, measured from inside the running Durable Object
 * (ticket 16) — the rule, free of any DO API so it is unit-testable in plain
 * node (spec §9.1). The ticker that feeds it lives in `arena-do.ts`, the read
 * side is `GET /api/arena-stats` in `router.ts`.
 *
 * ## Lateness, and the runtime where it means nothing
 *
 * A stopwatch around `arena.tick()` reads zero in production. workerd freezes
 * `Date.now()` for the whole synchronous run of an event (Spectre hardening):
 * the clock only moves when I/O happens, so "after the tick" is the same
 * instant as "before the tick". That is why the ticket-02 benchmark timed its
 * batches from OUTSIDE the object (`bench/do-cpu`).
 *
 * So this records the next best thing: how late each tick started against the
 * fixed 50 ms grid `startTicker` aims at. Where the clock advances during
 * synchronous work — local workerd, `wrangler dev`, the scenario suite — that
 * is the classic overrun signal: zero until a tick genuinely misses its slot,
 * and the size of the miss when it does.
 *
 * **On Cloudflare it is identically zero, and that is a measurement, not a
 * pass.** Ticket 16 ran a deployed arena at eight entities and 4 600 territory
 * vertices for five minutes: all 6 026 ticks landed in the lowest bucket and
 * `observedHz` read exactly 20.00. The isolate's clock is not merely frozen
 * during work — it is slaved to the timer schedule, so `Date.now()` at the top
 * of a tick returns the slot that tick was AIMED at, whatever really happened
 * in between. Nothing an over-running tick does can move it. (Consistent with
 * ticket 18, which found the same clock reporting a perfect 50.00 ms cadence
 * while the world outside saw ~22 ticks a second.)
 *
 * Hence `clockAdvances` in the report, probed once per arena: it says whether
 * the cost columns below it mean anything on this runtime. When it is false the
 * production instrument is the CLIENT side — snapshot ticks per wall-clock
 * second, which the deployed arena cannot fake (`bench/prod-arena`, and
 * `tests/soak/tickrate-probe.mjs` before it). What still carries information
 * here is `observedHz`: held against the rate a client observes, the difference
 * IS the clock skew of ticket 18.
 *
 * ## Why a histogram and not a list
 *
 * An arena ticks 20 times a second for as long as anyone plays. A growing array
 * would be an allocation per tick in the one loop that must not allocate
 * (mitigation 4 of the ticket-02 benchmark: allocation churn is what produced
 * the GC stalls that document measures). Fixed buckets cost one array index per
 * tick and never grow.
 */

import { TICK_DT_MS } from '@paintclash/shared';

/**
 * Upper bounds of the lateness buckets in ms, ascending. Placed around the
 * numbers the question is asked in rather than spread evenly: 25 ms is the
 * benchmark's p95 criterion (`docs/benchmarks/do-cpu-benchmark.md`) and 50 ms is
 * the tick budget itself, so a report can answer "does it hold?" without
 * interpolating between buckets.
 *
 * There is one bucket MORE than there are edges: everything past the last edge
 * lands in an open-ended one, whose only honest ceiling is the largest tick
 * actually seen.
 */
export const TICK_COST_EDGES_MS: readonly number[] = [1, 2, 4, 8, 12, 16, 25, 50, 100];

/** Buckets in a report: one per edge, plus the open one past the last edge. */
export const TICK_COST_BUCKETS = TICK_COST_EDGES_MS.length + 1;

/**
 * Does `Date.now()` move while this runtime burns CPU synchronously? Answers
 * whether a lateness reading can carry a tick's cost at all (see the header).
 *
 * Same shape as `bench/do-cpu`'s `probeClockAdvance`, and deliberately so — the
 * benchmark asks the same question of the same runtime. Called once per arena,
 * from `startTicker`: a few milliseconds when a world is created, against hours
 * of ticking, in exchange for a report that says whether to believe itself.
 */
export function clockAdvancesDuringWork(): boolean {
  const started = Date.now();
  let sink = 0;
  for (let i = 1; i <= 2_000_000; i++) sink += Math.sqrt(i);
  // `sink` has to escape, or the loop is dead code the optimizer may drop.
  return Date.now() > started && sink > 0;
}

/** One arena's running tick-cost tally. Mutated in place, never reallocated. */
export interface TickCost {
  /** DO-clock ms the window opened at — the tick loop's first schedule. */
  readonly openedMs: number;
  /** Whether the costs below can mean anything here (see `clockAdvancesDuringWork`). */
  readonly clockAdvances: boolean;
  /** Ticks recorded so far. */
  ticks: number;
  /** Sum of the recorded lateness, for the mean. */
  sumMs: number;
  maxMs: number;
  /** Ticks whose lateness reached the whole 50 ms budget. */
  overBudgetTicks: number;
  /** Counts per `TICK_COST_EDGES_MS`. */
  readonly buckets: Int32Array;
  /** Start of the previous tick, for the period; `null` before the first. */
  lastStartMs: number | null;
  /** Sum of the gaps between tick starts, for the observed rate. */
  periodSumMs: number;
  periods: number;
}

export interface TickCostReport {
  ticks: number;
  /**
   * `false` means every cost below is structurally zero on this runtime and
   * says nothing about the tick — read the client-side rate instead.
   */
  clockAdvances: boolean;
  /** How long this window has been open, in DO-clock ms. */
  windowMs: number;
  meanMs: number;
  /** Ceiling of the bucket the median landed in, clamped to `maxMs`. */
  p50Ms: number;
  /** Same, for the quantile the benchmark's 25 ms criterion is stated in. */
  p95Ms: number;
  maxMs: number;
  overBudgetTicks: number;
  /** Ticks per second as the DO's own clock saw them; 0 before the second tick. */
  observedHz: number;
  buckets: number[];
}

export function createTickCost(openedMs: number, clockAdvances: boolean): TickCost {
  return {
    openedMs,
    clockAdvances,
    ticks: 0,
    sumMs: 0,
    maxMs: 0,
    overBudgetTicks: 0,
    buckets: new Int32Array(TICK_COST_BUCKETS),
    lastStartMs: null,
    periodSumMs: 0,
    periods: 0,
  };
}

/**
 * Record one tick, starting now, that was aimed at `scheduledMs`.
 *
 * A tick that fired EARLY counts as on time rather than as negative cost: the
 * DO clock is not a promise (same caveat as `flood.ts`), and a backwards jump
 * must not be able to pull the mean down and hide a real overrun.
 */
export function recordTick(cost: TickCost, nowMs: number, scheduledMs: number): void {
  const lateMs = Math.max(0, nowMs - scheduledMs);
  cost.ticks += 1;
  cost.sumMs += lateMs;
  if (lateMs > cost.maxMs) cost.maxMs = lateMs;
  if (lateMs >= TICK_DT_MS) cost.overBudgetTicks += 1;
  const bucket = bucketOf(lateMs);
  cost.buckets[bucket] = (cost.buckets[bucket] ?? 0) + 1;
  if (cost.lastStartMs !== null) {
    // Every gap counts, stalls included: this is the rate the players in the
    // arena actually experienced, not a cleaned-up one.
    cost.periodSumMs += nowMs - cost.lastStartMs;
    cost.periods += 1;
  }
  cost.lastStartMs = nowMs;
}

/** Index of the first edge this lateness is below, else the open bucket. */
function bucketOf(lateMs: number): number {
  let index = 0;
  for (const edge of TICK_COST_EDGES_MS) {
    if (lateMs < edge) return index;
    index += 1;
  }
  return index;
}

/**
 * Upper bound of bucket `index`, clamped to the largest tick seen. The open
 * bucket has no edge of its own, so `maxMs` is the only bound it can honestly
 * carry — which is also what keeps a quantile from reporting `Infinity`.
 */
function ceilingOf(index: number, maxMs: number): number {
  return Math.min(TICK_COST_EDGES_MS[index] ?? Infinity, maxMs);
}

export function tickCostReport(cost: TickCost, nowMs: number): TickCostReport {
  return {
    ticks: cost.ticks,
    clockAdvances: cost.clockAdvances,
    windowMs: nowMs - cost.openedMs,
    meanMs: cost.ticks === 0 ? 0 : cost.sumMs / cost.ticks,
    p50Ms: quantile(cost, 0.5),
    p95Ms: quantile(cost, 0.95),
    maxMs: cost.maxMs,
    overBudgetTicks: cost.overBudgetTicks,
    observedHz: cost.periods === 0 ? 0 : 1000 / (cost.periodSumMs / cost.periods),
    buckets: [...cost.buckets],
  };
}

/**
 * The quantile as the CEILING of the bucket it falls in — deliberately not
 * interpolated. A histogram does not know where inside a bucket its ticks sat,
 * and inventing a position would dress a coarse measurement up as a precise one.
 */
function quantile(cost: TickCost, q: number): number {
  if (cost.ticks === 0) return 0;
  const rank = Math.ceil(q * cost.ticks);
  let seen = 0;
  let index = 0;
  for (const count of cost.buckets) {
    seen += count;
    if (seen >= rank) break;
    index += 1;
  }
  return ceilingOf(index, cost.maxMs);
}
