/**
 * Prediction + reconciliation for the own head (spec §6.1, Gambetta model):
 * every local input advances a local `sim-core` copy immediately; every
 * server snapshot re-bases that copy and replays the still-unacked inputs.
 * Corrections surface as a decaying visual offset ("weiches Nachziehen")
 * instead of a snap.
 */

import type { SnapshotPlayer } from '@paintclash/protocol';
import type { TurnSignal } from '@paintclash/shared';
import { advancePlayer, type PlayerSim } from '@paintclash/sim-core';

import { lerpAngle } from './interpolator.js';

/** Fraction of the visual error kept per tick — ~80 ms half-life at 20 Hz. */
const ERROR_DECAY = 0.65;
/** Corrections larger than this snap instead of gliding (teleport-grade). */
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
   * replay the rest — and fold the difference into the visual offset.
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
    this.prev ??= { ...replayed };
    if (before) {
      const dx = before.x + this.errorX - replayed.x;
      const dy = before.y + this.errorY - replayed.y;
      if (Math.hypot(dx, dy) <= MAX_GLIDE_WU) {
        this.errorX = dx;
        this.errorY = dy;
      } else {
        this.errorX = 0;
        this.errorY = 0;
      }
    }
  }

  /** Shrink the correction offset — call once per sim tick. */
  decayError(): void {
    this.errorX *= ERROR_DECAY;
    this.errorY *= ERROR_DECAY;
  }

  /**
   * Render pose between the previous and current predicted tick
   * (render interpolation is mandatory, spec §4.3), plus the error offset.
   */
  sample(alpha: number): RenderPose | null {
    if (!this.curr) return null;
    const from = this.prev ?? this.curr;
    const a = Math.min(1, Math.max(0, alpha));
    return {
      x: from.x + (this.curr.x - from.x) * a + this.errorX,
      y: from.y + (this.curr.y - from.y) * a + this.errorY,
      heading: lerpAngle(from.heading, this.curr.heading, a),
    };
  }
}
