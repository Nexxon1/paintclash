/**
 * Prediction + reconciliation for the own head (spec §6.1, Gambetta model):
 * every local input advances a local `sim-core` copy immediately; every
 * server snapshot re-bases that copy and replays the still-unacked inputs.
 * Corrections surface as decaying visual offsets — position AND heading —
 * ("weiches Nachziehen") instead of a snap.
 *
 * The error offsets decay per RENDERED frame (wall time), not per sim tick:
 * after a main-thread stall the client fast-forwards many sim ticks before
 * the next paint, and tick-based decay would swallow the whole glide
 * invisibly — the pose would just teleport.
 */

import type { SnapshotPlayer } from '@paintclash/protocol';
import type { TurnSignal } from '@paintclash/shared';
import { advancePlayer, type PlayerSim } from '@paintclash/sim-core';

import { angleDiff, lerpAngle } from './interpolator.js';

/** Fraction of the visual error kept per 50 ms — ~80 ms half-life. */
const ERROR_DECAY_PER_TICK = 0.65;
/**
 * Largest position offset that glides. Bigger divergence (a long stall while
 * the world kept moving) glides these 8 WU and JUMPS the rest — gliding tens
 * of WU would look like flying. Heading needs no cap: its offset is wrapped
 * to the shortest arc, so it never glides more than 180°.
 */
const MAX_GLIDE_WU = 8;

export interface RenderPose {
  x: number;
  y: number;
  heading: number;
}

export class Predictor {
  private readonly arenaSizeWU: number;
  private pending: { seq: number; turn: TurnSignal }[] = [];
  private prev: PlayerSim | null = null;
  private curr: PlayerSim | null = null;
  private errorX = 0;
  private errorY = 0;
  private errorH = 0;

  constructor(arenaSizeWU: number) {
    this.arenaSizeWU = arenaSizeWU;
  }

  /** The predicted state at the current sim tick (no smoothing applied). */
  current(): PlayerSim | null {
    return this.curr;
  }

  /** Record + immediately apply one local input (one fixed tick). */
  applyLocalInput(seq: number, turn: TurnSignal, dtSec: number): void {
    if (!this.curr) return;
    this.pending.push({ seq, turn });
    this.prev = { ...this.curr };
    this.curr.turn = turn;
    advancePlayer(this.curr, this.arenaSizeWU, dtSec);
  }

  /**
   * Server correction: adopt the authoritative state, drop acked inputs,
   * replay the rest — and fold the difference into the visual offsets. The
   * rendered pose stays CONTINUOUS at this very moment (whatever alpha the
   * renderer is at); the correction surfaces only through frame-based decay.
   * Divergence beyond the glide caps jumps the excess and glides the rest.
   */
  reconcile(self: SnapshotPlayer, ackSeq: number, dtSec: number): void {
    const before = this.curr ? { ...this.curr } : null;
    this.pending = this.pending.filter((input) => input.seq > ackSeq);
    const replayed: PlayerSim = { ...self };
    for (const input of this.pending) {
      replayed.turn = input.turn;
      advancePlayer(replayed, this.arenaSizeWU, dtSec);
    }
    this.curr = replayed;
    const prev = (this.prev ??= { ...replayed });
    if (!before) return;

    // Shift the interpolation segment along with the correction …
    prev.x += replayed.x - before.x;
    prev.y += replayed.y - before.y;
    prev.heading += angleDiff(before.heading, replayed.heading);
    // … and keep the rendered pose where it was via the offsets.
    this.errorX = before.x + this.errorX - replayed.x;
    this.errorY = before.y + this.errorY - replayed.y;
    this.errorH = angleDiff(0, this.errorH + angleDiff(replayed.heading, before.heading));

    // Cap: glide at most MAX_GLIDE — the excess jumps once, honestly.
    const magnitude = Math.hypot(this.errorX, this.errorY);
    if (magnitude > MAX_GLIDE_WU) {
      const scale = MAX_GLIDE_WU / magnitude;
      this.errorX *= scale;
      this.errorY *= scale;
    }
  }

  /**
   * Run `fn` (e.g. a burst of catch-up inputs after a stall) and fold the
   * entire resulting pose change into the offsets: the rendered pose stays
   * where it was and glides — the burst never appears as one giant frame.
   */
  runGlided(fn: () => void): void {
    if (!this.curr) {
      fn();
      return;
    }
    const beforeX = this.curr.x + this.errorX;
    const beforeY = this.curr.y + this.errorY;
    const beforeH = this.curr.heading + this.errorH;
    fn(); // never nulls `curr` — it only advances or replaces it
    this.errorX = beforeX - this.curr.x;
    this.errorY = beforeY - this.curr.y;
    this.errorH = angleDiff(this.curr.heading, beforeH);
    this.prev = { ...this.curr };
    const magnitude = Math.hypot(this.errorX, this.errorY);
    if (magnitude > MAX_GLIDE_WU) {
      const scale = MAX_GLIDE_WU / magnitude;
      this.errorX *= scale;
      this.errorY *= scale;
    }
  }

  /**
   * Shrink the correction offsets. Call once per rendered frame with the real
   * frame duration (capped, so a post-stall mega-frame doesn't swallow the
   * whole glide before it was ever visible).
   */
  decayError(frameDtMs = 50): void {
    const factor = ERROR_DECAY_PER_TICK ** (Math.min(frameDtMs, 100) / 50);
    this.errorX *= factor;
    this.errorY *= factor;
    this.errorH *= factor;
  }

  /**
   * Render pose between the previous and current predicted tick
   * (render interpolation is mandatory, spec §4.3), plus the error offsets.
   */
  sample(alpha: number): RenderPose | null {
    if (!this.curr) return null;
    const from = this.prev ?? this.curr;
    const a = Math.min(1, Math.max(0, alpha));
    const heading = lerpAngle(from.heading, this.curr.heading, a) + this.errorH;
    const TWO_PI = 2 * Math.PI;
    return {
      x: from.x + (this.curr.x - from.x) * a + this.errorX,
      y: from.y + (this.curr.y - from.y) * a + this.errorY,
      heading: ((heading % TWO_PI) + TWO_PI) % TWO_PI,
    };
  }
}
