import { LIMITS } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { chargeFrame, type FrameWindow } from './flood.js';

const CAP = LIMITS.framesPerWindow;
const WINDOW = LIMITS.frameWindowMs;

/** Send `count` frames at one instant; the verdicts in order, and what is left. */
function burst(
  count: number,
  nowMs = 1_000,
  from?: FrameWindow,
): { verdicts: string[]; window: FrameWindow } {
  let window = from;
  const verdicts: string[] = [];
  for (let i = 0; i < count; i++) {
    const charged = chargeFrame(window, nowMs);
    verdicts.push(charged.verdict);
    window = charged.window;
  }
  if (!window) throw new Error('a burst of nothing charges nothing');
  return { verdicts, window };
}

/** The window a socket holds after flooding `windows` consecutive windows. */
function afterFloodingWindows(windows: number): FrameWindow {
  let window: FrameWindow | undefined;
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i <= CAP; i++) {
      window = chargeFrame(window, 1_000 + w * WINDOW).window;
    }
  }
  if (!window) throw new Error('no window');
  return window;
}

describe('per-connection frame budget (spec §8.3 point 2)', () => {
  it('accepts the whole budget, then drops the surplus unparsed', () => {
    const { verdicts } = burst(CAP + 2);
    expect(verdicts.slice(0, CAP)).toEqual(Array.from({ length: CAP }, () => 'accept'));
    // Dropping rather than killing on the first excess frame: a client that
    // bursts after a stall is not an attacker, and the frames it loses are
    // steer intents that the tick mapping would have superseded anyway.
    expect(verdicts.slice(CAP)).toEqual(['drop', 'drop']);
  });

  it('kills a socket that keeps it up for the whole tolerance window', () => {
    // Two full windows of flooding are tolerated (dropped); the third is where
    // "anhaltender Flood" is established and the socket goes.
    const tolerated = afterFloodingWindows(LIMITS.floodKillWindows - 1);
    expect(tolerated.floodWindows).toBe(LIMITS.floodKillWindows - 1);
    const lastWindow = 1_000 + (LIMITS.floodKillWindows - 1) * WINDOW;
    const { verdicts } = burst(CAP + 1, lastWindow, tolerated);
    expect(verdicts.slice(0, CAP)).toEqual(Array.from({ length: CAP }, () => 'accept'));
    expect(verdicts[CAP]).toBe('kill');
  });

  it('forgives bursts that are separated by an ordinary second', () => {
    // The streak counts CONSECUTIVE flooding windows, so a client that overshoots
    // once (a post-stall flush), sends at its normal cadence for a second and
    // overshoots again must never accumulate a kick out of the two. Here it does
    // that `floodKillWindows` times over — the pattern that kills is
    // back-to-back windows, and this is not it.
    let window: FrameWindow | undefined;
    for (let round = 0; round < LIMITS.floodKillWindows + 1; round++) {
      const floodingAt = 1_000 + round * 2 * WINDOW;
      const bursted = burst(CAP + 1, floodingAt, window);
      for (const verdict of bursted.verdicts) {
        expect(verdict, `round ${String(round)} must not kill`).not.toBe('kill');
      }
      // The quiet second in between, at an ordinary client's cadence.
      window = bursted.window;
      for (let i = 0; i < 7; i++) window = chargeFrame(window, floodingAt + WINDOW).window;
    }
    // Spent, not merely unused: the quiet window ends the streak as it closes,
    // so the next frame after it starts from zero however many bursts came
    // before.
    const next = chargeFrame(window, 1_000 + (LIMITS.floodKillWindows + 1) * 2 * WINDOW);
    expect(next.window.floodWindows).toBe(0);
  });

  it('forgives bursts that are separated by silence', () => {
    // The other way a streak must not accumulate: no traffic at all in between.
    // A backgrounded tab that flushes whatever it queued on every wake-up would
    // otherwise be killed by bursts minutes apart — "anhaltend" means the
    // windows touch, not that they happened.
    let window: FrameWindow | undefined;
    for (let round = 0; round < LIMITS.floodKillWindows + 2; round++) {
      const wakeAt = 1_000 + round * 600 * WINDOW; // ten minutes of silence
      const bursted = burst(CAP + 1, wakeAt, window);
      for (const verdict of bursted.verdicts) {
        expect(verdict, `wake-up ${String(round)} must not kill`).not.toBe('kill');
      }
      window = bursted.window;
      expect(window.floodWindows).toBe(1);
    }
  });

  it('opens a fresh window on first contact', () => {
    const charged = chargeFrame(undefined, 7_000);
    expect(charged.verdict).toBe('accept');
    expect(charged.window).toEqual({ startedMs: 7_000, frames: 1, floodWindows: 0 });
  });

  it('rolls the window instead of extending it', () => {
    const spent = { startedMs: 1_000, frames: CAP, floodWindows: 0 };
    expect(chargeFrame(spent, 1_000 + WINDOW - 1).verdict).toBe('drop');
    const rolled = chargeFrame(spent, 1_000 + WINDOW);
    expect(rolled.verdict).toBe('accept');
    expect(rolled.window).toEqual({ startedMs: 1_000 + WINDOW, frames: 1, floodWindows: 0 });
  });

  it('does not kill a socket over a clock that jumped backwards', () => {
    // Same guard as the room-creation budget: the DO's clock is not a promise
    // (see the tick-rate skew documented in `arena-do.ts`), and a window stamped
    // in the future must not mute a player until real time catches up with it.
    const future = { startedMs: 5_000_000, frames: CAP, floodWindows: 2 };
    const charged = chargeFrame(future, 1_000);
    expect(charged.verdict).toBe('accept');
    expect(charged.window.startedMs).toBe(1_000);
  });

  it('leaves an ordinary playing client far below the cap', () => {
    // A client sends one input batch every `inputFlushTicks` ticks. That rate,
    // for a whole window, must not even approach the budget — the cap protects
    // the arena from a flood, it does not shape normal traffic.
    const framesPerWindow = WINDOW / (LIMITS.inputFlushTicks * 50);
    expect(framesPerWindow * 3).toBeLessThan(CAP);
  });
});
