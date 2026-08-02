import { describe, expect, it } from 'vitest';
import { longestRePassWU, wallSlides } from './wall-slide';

/**
 * The measure behind the wall-jitter premise in `death.test.ts` (ticket 27).
 *
 * It lives in its own file because the choreography it serves takes ~20 s of
 * real workerd to produce a single series — iterating on the measurement there
 * is a debugging round per attempt. Here the awkward series are written down
 * directly, including the one that took the choreography down.
 */

/** A clean ramp from `from` to `to`, one `step` per sample. */
function ramp(from: number, to: number, step = 0.45): number[] {
  const direction = Math.sign(to - from);
  const xs: number[] = [];
  for (let x = from; direction * (to - x) > 0; x += direction * step) xs.push(x);
  xs.push(to);
  return xs;
}

/**
 * A ramp the way a wall-pinned head actually walks one: `back` WU of retreat
 * every `forward` WU of progress. This is the shape that broke the old premise.
 */
function sawtoothRamp(from: number, to: number, forward = 0.8, back = 0.1): number[] {
  const direction = Math.sign(to - from);
  const xs: number[] = [from];
  for (let x = from; direction * (to - x) > forward;) {
    x += direction * forward;
    xs.push(x);
    x -= direction * back;
    xs.push(x);
  }
  xs.push(to);
  return xs;
}

const DEADBAND = 2;

/** The two under test, composed the way the choreography composes them. */
function rePass(xs: readonly number[]): number {
  return longestRePassWU(wallSlides(xs, DEADBAND));
}

describe('wallSlides', () => {
  it('has nothing to report about a head that never moved', () => {
    expect(wallSlides([], DEADBAND)).toEqual([]);
    expect(wallSlides([10, 10, 10], DEADBAND)).toEqual([]);
  });

  it('ignores a wobble that never leaves the deadband', () => {
    expect(wallSlides([10, 10.8, 10.1, 10.9, 10.2], DEADBAND)).toEqual([]);
  });

  it('reports one slide for one clean run', () => {
    expect(wallSlides(ramp(10, 19), DEADBAND)).toEqual([{ from: 10, to: 19 }]);
  });

  it('reports one slide for one SAWTOOTH run — the case that broke the premise', () => {
    // Chopping at every sign change (what the test used to do) turns this into
    // ~4/0.1/0.8/0.1/0.8/… and reads a 9 WU leg as a handful of short ones.
    const slides = wallSlides(sawtoothRamp(10, 19), DEADBAND);
    expect(slides).toHaveLength(1);
    expect(slides[0]?.from).toBeCloseTo(10);
    expect(slides[0]?.to).toBeCloseTo(19);
  });

  it('splits at a reversal that clears the deadband, and keeps the full leg', () => {
    // The recorded leg runs to the turning point, not to where the reversal was
    // recognised — a deadband delays the verdict, it does not shorten the slide.
    const slides = wallSlides([...ramp(10, 19), ...ramp(19, 13)], DEADBAND);
    expect(slides).toHaveLength(2);
    expect(slides[0]?.to).toBeCloseTo(19);
    expect(slides[1]?.from).toBeCloseTo(19);
    expect(slides[1]?.to).toBeCloseTo(13);
  });

  it('does not split at a reversal that stays inside the deadband', () => {
    const slides = wallSlides([...ramp(10, 19), ...ramp(19, 17.5), ...ramp(17.5, 25)], DEADBAND);
    expect(slides).toHaveLength(1);
    expect(slides[0]?.to).toBeCloseTo(25);
  });

  it('starts the first slide at the turning point, not at the first sample', () => {
    // A head that drifts a little the wrong way before committing: the leg is
    // the whole run from where it turned, not from where the series happens to
    // begin.
    const slides = wallSlides([...ramp(10, 9), ...ramp(9, 19)], DEADBAND);
    expect(slides).toHaveLength(1);
    expect(slides[0]?.from).toBeCloseTo(9);
    expect(slides[0]?.to).toBeCloseTo(19);
  });
});

describe('longestRePassWU', () => {
  it('is zero when the head only ever went one way', () => {
    expect(rePass(ramp(10, 25))).toBe(0);
    expect(rePass([])).toBe(0);
  });

  it('measures the stretch driven twice, not the length of either leg', () => {
    expect(rePass([...ramp(10, 16), ...ramp(16, 10)])).toBeCloseTo(6);
  });

  it('counts only the overlap when the way back falls short', () => {
    expect(rePass([...ramp(10, 16), ...ramp(16, 14)])).toBeCloseTo(2);
  });

  it('counts only the overlap when the way back overshoots into fresh wall', () => {
    // Out 2, back 8: six of those eight WU are wall the head had never touched,
    // so they prove nothing about driving over its own line.
    expect(rePass([...ramp(10, 12), ...ramp(12, 4)])).toBeCloseTo(2);
  });

  it('reports the best re-pass of several', () => {
    const xs = [...ramp(10, 13), ...ramp(13, 10), ...ramp(10, 22), ...ramp(22, 10)];
    expect(rePass(xs)).toBeCloseTo(12);
  });

  it('survives the sawtooth — the whole point of the deadband', () => {
    const xs = [...sawtoothRamp(10, 16), ...sawtoothRamp(16, 10)];
    expect(rePass(xs)).toBeCloseTo(6);
  });
});
