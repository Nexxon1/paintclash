/**
 * Measuring a wall re-pass from the head's poses (ticket 27).
 *
 * The soft-barrier choreography in `death.test.ts` has to establish one thing
 * before its rule means anything: the head really drove back over a stretch of
 * wall it had already laid trail on. The trail itself is not on the wire past
 * the join-time world sync, so the only evidence is the series of head x
 * positions taken while the head was pinned to the wall.
 *
 * That series is not a clean ramp. A head pressed into the wall saws back and
 * forth by a fraction of a tick's step while it slides — measured runs like
 * `3.8/0.1/0.8/0.1/0.8/0.1/0.8` are ONE ~6 WU leg, not seven. Splitting the
 * series at every direction reversal (what this test did until ticket 27) reads
 * that leg as a handful of short ones, and a premise phrased as "two runs of at
 * least half a leg" then fails on timing rather than on the maneuver — leaving
 * the actual assertion, that nobody died, unreached.
 *
 * So two changes of shape. Slides are cut with a **deadband**: a reversal ends a
 * slide only once the head has genuinely retreated from that slide's turning
 * point. And the premise is the **overlap** of two consecutive slides in
 * opposite directions — the stretch of wall the head covered twice — which is
 * the thing the test is about, said directly, rather than inferred from how long
 * two separate runs happened to be.
 */

/** One slide along the wall: the head went from x `from` to x `to`. */
export interface Slide {
  readonly from: number;
  readonly to: number;
}

/**
 * The head's slides along the wall, sawtooth filtered out.
 *
 * `deadbandWU` is how far the head must retreat from a slide's turning point
 * before the retreat counts as a new slide. Pick it above the sawtooth and below
 * the legs the choreography flies. A slide is recorded up to its turning point,
 * so the deadband delays the verdict without shortening the slide.
 *
 * A series that never leaves the deadband has no slides at all — the head
 * wobbled, it did not go anywhere.
 */
export function wallSlides(xs: readonly number[], deadbandWU: number): Slide[] {
  const slides: Slide[] = [];
  const first = xs[0];
  if (first === undefined) return slides;

  // Before the first slide commits, the extremes so far are the candidates for
  // where it started: a head that drifts the wrong way and then turns began its
  // slide at the turn, not at whichever sample the series opens on.
  let low = first;
  let high = first;
  let direction = 0;
  let from = first;
  let turn = first;

  for (const x of xs) {
    if (direction === 0) {
      low = Math.min(low, x);
      high = Math.max(high, x);
      if (x - low >= deadbandWU) {
        direction = 1;
        from = low;
      } else if (high - x >= deadbandWU) {
        direction = -1;
        from = high;
      } else {
        continue;
      }
      turn = x;
      continue;
    }
    if ((x - turn) * direction > 0) {
      turn = x;
    } else if ((turn - x) * direction >= deadbandWU) {
      slides.push({ from, to: turn });
      from = turn;
      turn = x;
      direction = -direction;
    }
  }
  if (direction !== 0) slides.push({ from, to: turn });
  return slides;
}

/**
 * The longest stretch of wall the head drove twice in opposite directions.
 *
 * Consecutive slides share their turning point and run opposite ways, so the
 * stretch covered by both is the shorter of the two: a way back that falls short
 * re-drives only as far as it got, and one that overshoots re-drives only what
 * was there to re-drive — the rest is wall the head had never touched, which
 * proves nothing about driving over its own line.
 *
 * Takes the slides rather than the raw series, so a caller that also wants to
 * print them cuts them once.
 *
 * Zero means the head never came back.
 */
export function longestRePassWU(slides: readonly Slide[]): number {
  let best = 0;
  for (let i = 1; i < slides.length; i++) {
    const back = slides[i];
    const out = slides[i - 1];
    if (!back || !out) continue;
    best = Math.max(best, Math.min(Math.abs(out.to - out.from), Math.abs(back.to - back.from)));
  }
  return best;
}
