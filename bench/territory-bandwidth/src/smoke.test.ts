import { describe, expect, it } from 'vitest';

import { meanAfter, plateauOf, runBandwidth, savingFactor } from './harness.js';

/**
 * The harness' own premise, in seconds rather than hours: if the bots do not
 * paint, or the send path emits nothing, the measurement run would report a
 * tidy 0 KB/s and pass for entirely the wrong reason.
 */
describe('territory-bandwidth harness', () => {
  it('emits territory frames while the bots paint', async () => {
    const run = await runBandwidth({
      arenaSizeWU: 200,
      bots: 8,
      seconds: 20,
      seed: 20260730,
      tolerancesWU: [0.1],
    });
    expect(
      run.closures,
      `${String(run.closures)} loop closures in 20 s — the bots barely painted, so there is ` +
        `no territory whose egress this run could describe`,
    ).toBeGreaterThan(10);
    // Eight bots spawning on tick 0 are eight `sync` frames before any fill.
    expect(run.syncFrames).toBeGreaterThanOrEqual(8);
    expect(
      run.fillFrames,
      'the arena closed loops but the send path emitted no fill frame — the two are the ' +
        'same event, so this is a bug in the harness, not a quiet arena',
    ).toBeGreaterThan(10);
    let bytes = 0;
    for (const b of run.bytesPerSecond) bytes += b;
    // A 6×6 start block frame is 5 + 1 + 2 + 4×8 = 40 bytes; eight of those is
    // the floor a run that painted nothing would report.
    expect(bytes).toBeGreaterThan(8 * 40);
    expect(run.peakFrameBytes).toBeGreaterThan(40);
  });

  /**
   * Decimation must actually decimate. A tolerance sweep whose "after" column
   * silently equals its "before" column is the failure mode this bench would be
   * least able to spot from its own table, because both numbers look plausible.
   */
  it('prices a coarse tolerance below the full territory', async () => {
    const run = await runBandwidth({
      arenaSizeWU: 200,
      bots: 8,
      seconds: 30,
      seed: 20260730,
      tolerancesWU: [0.5],
    });
    const baseline = meanAfter(run.bytesPerSecond, 0);
    const decimated = meanAfter(run.tolerances[0]?.bytesPerSecond ?? [], 0);
    expect(
      decimated,
      `0,5 WU of tolerance changed the frame size not at all (${String(baseline)} bytes/s ` +
        `either way) — the sweep is measuring the same geometry twice`,
    ).toBeLessThan(baseline);
    expect(run.tolerances[0]?.deviationSamples).toBeGreaterThan(0);
  });
});

/**
 * The measurement run's premise, as arithmetic rather than a four-hour wait
 * (rule 8 of the scenario suite's README, applied here): an egress mean taken
 * from the ramp is not a baseline. Measured in milliseconds so a mistake in the
 * window split is not something you discover at the end of a 288 000-tick run.
 */
describe('plateauOf', () => {
  it('reports no comparable window when the run ends inside the settle time', () => {
    expect(plateauOf([1, 2, 3], 10)).toEqual({
      halfWindowSec: 0,
      earlyMean: 0,
      lateMean: 0,
      driftFraction: 0,
    });
  });

  it('splits the post-settle series in half and reports the drift between them', () => {
    // Settle drops [9, 9]; the remaining four seconds halve into 100 and 110.
    const plateau = plateauOf([9, 9, 100, 100, 110, 110], 2);
    expect(plateau.halfWindowSec).toBe(2);
    expect(plateau.earlyMean).toBe(100);
    expect(plateau.lateMean).toBe(110);
    expect(plateau.driftFraction).toBeCloseTo(0.1, 10);
  });

  it('reads a shrinking series as negative drift', () => {
    expect(plateauOf([0, 200, 100], 1).driftFraction).toBeCloseTo(-0.5, 10);
  });

  it('drops the odd middle second, so both halves are the same width', () => {
    const plateau = plateauOf([10, 999, 20], 0);
    expect(plateau.halfWindowSec).toBe(1);
    expect(plateau.earlyMean).toBe(10);
    expect(plateau.lateMean).toBe(20);
  });

  it('calls an arena that emitted nothing drift-free rather than dividing by zero', () => {
    // Trivially true, and deliberately not this function's job to catch: that
    // the bots painted at all is a separate premise (`closures`, `fillFrames`).
    expect(plateauOf([0, 0, 0, 0], 0).driftFraction).toBe(0);
  });
});

describe('meanAfter', () => {
  it('averages only the seconds past the settle', () => {
    expect(meanAfter([1000, 1000, 10, 20, 30], 2)).toBe(20);
  });

  it('reads a series that never leaves the settle as 0 rather than NaN', () => {
    expect(meanAfter([1, 2], 5)).toBe(0);
  });
});

describe('savingFactor', () => {
  it('reads half the bytes as a 2× saving', () => {
    expect(savingFactor(6300, 3150)).toBe(2);
  });

  it('reads an unchanged frame as no saving at all', () => {
    expect(savingFactor(6300, 6300)).toBe(1);
  });

  /**
   * A tolerance that erased every territory sends only frame headers. That is
   * not a 1 000× win to be celebrated, it is a broken measurement, and reading
   * as infinite is the loudest way to say so.
   */
  it('calls a saving down to nothing infinite rather than dividing by zero', () => {
    expect(savingFactor(6300, 0)).toBe(Infinity);
    expect(savingFactor(0, 0)).toBe(1);
  });
});
