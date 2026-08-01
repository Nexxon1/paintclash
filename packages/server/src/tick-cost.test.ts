import { describe, expect, it } from 'vitest';

import { TICK_COST_BUCKETS, createTickCost, recordTick, tickCostReport } from './tick-cost.js';

/** Record a run of ticks that each fired `lateMs` after their slot. */
function record(late: readonly number[], periodMs = 50): ReturnType<typeof createTickCost> {
  const cost = createTickCost(1_000);
  let scheduled = 1_000;
  let now = 1_000;
  for (const lateMs of late) {
    now = scheduled + lateMs;
    recordTick(cost, now, scheduled);
    scheduled = now - lateMs + periodMs;
  }
  return cost;
}

describe('tick cost recorder', () => {
  it('reports nothing before the first tick', () => {
    const report = tickCostReport(createTickCost(1_000), 1_000);
    expect(report.ticks).toBe(0);
    expect(report.meanMs).toBe(0);
    expect(report.maxMs).toBe(0);
    expect(report.p95Ms).toBe(0);
    expect(report.observedHz).toBe(0);
    expect(report.overBudgetTicks).toBe(0);
  });

  it('averages the lateness it was given', () => {
    const report = tickCostReport(record([1, 3, 5, 7]), 2_000);
    expect(report.ticks).toBe(4);
    expect(report.meanMs).toBeCloseTo(4, 6);
    expect(report.maxMs).toBe(7);
  });

  it('counts a tick that ate its whole budget as over budget', () => {
    const report = tickCostReport(record([2, 50, 3, 120]), 2_000);
    expect(report.overBudgetTicks).toBe(2);
  });

  it('quantiles are the ceiling of the bucket they land in, never above the max', () => {
    // Eighteen cheap ticks and two expensive ones: p50 sits in the first
    // bucket, p95 in the one the outliers landed in — reported as that bucket's
    // ceiling (50 ms), clamped to the largest tick actually seen.
    const report = tickCostReport(record([...Array<number>(18).fill(0.2), 30, 30]), 2_000);
    expect(report.p50Ms).toBe(1);
    expect(report.p95Ms).toBe(30);
    expect(report.maxMs).toBe(30);
  });

  it('never reports a quantile above the largest tick it saw', () => {
    // Everything in the open-ended top bucket, whose ceiling is Infinity.
    const report = tickCostReport(record([400, 500, 600]), 2_000);
    expect(report.p95Ms).toBe(600);
    expect(Number.isFinite(report.p50Ms)).toBe(true);
  });

  it('buckets every tick exactly once', () => {
    const late = [0, 0.5, 1.5, 3, 6, 10, 14, 20, 40, 80, 500];
    const report = tickCostReport(record(late), 2_000);
    expect(report.buckets).toHaveLength(TICK_COST_BUCKETS);
    expect(report.buckets.reduce((sum, n) => sum + n, 0)).toBe(late.length);
  });

  it('treats a tick that fired early as on time rather than as negative cost', () => {
    // The DO clock is not a promise (see `flood.ts`); a backwards jump must not
    // pull the mean below zero and hide a real overrun.
    const report = tickCostReport(record([-20, 4]), 2_000);
    expect(report.meanMs).toBeCloseTo(2, 6);
    expect(report.maxMs).toBe(4);
  });

  it('derives the observed tick rate from the gaps between tick starts', () => {
    // Ten ticks, 45 ms apart by the DO's own clock → 22.2 Hz, the production
    // skew ticket 18 measured from the outside.
    const report = tickCostReport(record(Array<number>(10).fill(0), 45), 2_000);
    expect(report.observedHz).toBeCloseTo(1000 / 45, 3);
  });

  it('has no rate to report from a single tick', () => {
    expect(tickCostReport(record([1]), 2_000).observedHz).toBe(0);
  });

  it('reports how long the window it summarises has been open', () => {
    expect(tickCostReport(createTickCost(1_000), 4_500).windowMs).toBe(3_500);
  });
});
