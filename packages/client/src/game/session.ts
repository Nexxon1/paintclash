/**
 * ClientSession — everything the browser client does except DOM, WebSocket
 * and rendering: protocol handling, prediction/reconciliation for the own
 * head, interpolation for the others, and batched intent sending
 * (spec §6.1/6.3). `main.ts` owns the real I/O and calls in.
 */

import {
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  MAX_INPUT_BATCH,
  type InputItem,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import { BALANCE, LIMITS, TICK_DT_MS, TICK_DT_SEC, type TurnSignal } from '@paintclash/shared';

import { angleDiff, Interpolator } from './interpolator.js';
import { Predictor, type RenderPose } from './predictor.js';

/** Sim ticks per batched input frame — the shared §6.3 batching cadence. */
export const INPUT_FLUSH_TICKS = LIMITS.inputFlushTicks;

/**
 * Base delay behind estimated server time for enemy rendering (spec §6.1).
 * 3 ticks = 150 ms of headroom on a clean link. Real links (WSL2 port
 * forwarding, wifi) deliver snapshots in bursts: whenever the render clock
 * catches the newest snapshot (starvation = enemy freezes a frame, then
 * catches up = constant micro-stutter), the delay adapts upward; it slowly
 * shrinks again while delivery stays smooth. All well inside the genre's
 * ~500 ms tolerance (spec §6.3).
 */
const INTERP_DELAY_TICKS = 3;
const MAX_EXTRA_DELAY_TICKS = 6;
/** Ticks of starvation-free running before the extra delay shrinks by one. */
const DELAY_SHRINK_AFTER_TICKS = 600; // 30 s

/**
 * EMA weight for the server-clock offset. The enemy timeline must advance on
 * the *local* tick clock — pinning it to snapshot arrival times would turn
 * every bit of network jitter into a visible time jump. Samples are
 * quantized to whole ticks, so the weight stays small.
 */
const OFFSET_SMOOTHING = 0.05;

/** An offset this many ticks off is a real clock break — resync hard. */
const OFFSET_RESYNC_TICKS = 10;

/** Fastest the enemy timeline may run while catching up (2 = double speed). */
const MAX_TIMEWARP = 2;

/**
 * Beyond this many ticks of render-clock lag, catching up smoothly would
 * take seconds — snap once instead (hidden-tab comebacks, not hitches).
 */
const MAX_RENDER_LAG_TICKS = 20;

/**
 * Display-side speed limit for enemies: whatever the timeline does (their
 * catch-up drain, our clock warp), a rendered enemy moves at most this
 * multiple of nominal speed. Distances beyond MAX_ENEMY_GLIDE_WU are
 * teleport-grade (e.g. a future respawn) and snap instead.
 */
const MAX_ENEMY_SPEEDUP = 2.2;
const MAX_ENEMY_GLIDE_WU = 8;
/** Enemy heading may re-align at most this multiple of the sim turn rate. */
const MAX_ENEMY_TURN_SPEEDUP = 2.2;

export interface RenderState {
  self: RenderPose | null;
  /** Center of the own 6×6 start block, once spawned. */
  selfBlock: { cx: number; cy: number } | null;
  others: SnapshotPlayer[];
  arenaSizeWU: number | null;
}

export class ClientSession {
  playerId: number | null = null;
  arenaSizeWU: number | null = null;

  private readonly send: (frame: Uint8Array) => void;
  private readonly name: string;
  private predictor: Predictor | null = null;
  private readonly interpolator = new Interpolator();
  private queued: InputItem[] = [];
  private nextSeq = 1; // server acks 0 = "nothing yet"
  private ticksSinceFlush = 0;
  private selfBlock: { cx: number; cy: number } | null = null;
  /** Local sim ticks since start — the smooth clock everything renders on. */
  private clientTicks = 0;
  /** Turn value of the last flushed tick — direction changes flush eagerly. */
  private lastSentTurn: TurnSignal = 0;
  /** EMA of (server tick − local tick); null until the first snapshot. */
  private serverOffset: number | null = null;
  /** Rate-limited enemy timeline (see renderSample). */
  private renderTick: number | null = null;
  /** Adaptive addition to INTERP_DELAY_TICKS (starvation-driven). */
  private extraDelayTicks = 0;
  /** Local tick of the last starvation (or last shrink step). */
  private lastStarvationTick = 0;
  /** Last rendered pose per enemy — display-side speed limiting. */
  private readonly enemyPoses = new Map<number, { x: number; y: number; heading: number }>();

  constructor(send: (frame: Uint8Array) => void, name: string) {
    this.send = send;
    this.name = name;
  }

  join(): void {
    this.send(encodeJoin(this.name));
  }

  /** Ready = welcomed and the own player appeared in a snapshot. */
  ready(): boolean {
    return this.predictor !== null && this.predictor.current() !== null;
  }

  /** Feed one raw server frame; malformed frames are dropped. */
  receive(frame: Uint8Array | ArrayBuffer): void {
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    const message = decodeServerMessage(bytes);
    if (!message) return;
    if (message.type === 'welcome') {
      this.playerId = message.playerId;
      this.arenaSizeWU = message.arenaSizeWU;
      this.predictor = new Predictor(message.arenaSizeWU);
      return;
    }
    const latest = this.interpolator.latestTick();
    if (latest !== null && message.tick <= latest) return;
    this.interpolator.add(message.tick, message.players);
    const offsetSample = message.tick - this.clientTicks;
    this.serverOffset =
      this.serverOffset === null || Math.abs(offsetSample - this.serverOffset) > OFFSET_RESYNC_TICKS
        ? offsetSample
        : this.serverOffset + OFFSET_SMOOTHING * (offsetSample - this.serverOffset);
    const self =
      this.playerId === null ? undefined : message.players.find((p) => p.id === this.playerId);
    if (self && this.predictor) {
      this.selfBlock = { cx: self.blockCx, cy: self.blockCy };
      this.predictor.reconcile(self, message.ackSeq, TICK_DT_SEC);
    }
  }

  /**
   * Advance `ticks` fixed steps at once. A single tick renders normally
   * (regular frame pacing); any multi-tick burst — a hiccup's or stall's
   * catch-up — is folded into the glide offsets so the own head never
   * leaps on screen.
   */
  advance(turn: TurnSignal, ticks: number): void {
    if (ticks <= 0) return;
    if (ticks <= 1 || !this.predictor) {
      for (let i = 0; i < ticks; i++) this.simTick(turn);
      return;
    }
    this.predictor.runGlided(() => {
      for (let i = 0; i < ticks; i++) this.simTick(turn);
    });
  }

  /** One fixed 20 Hz tick: sample input, predict, batch, maybe flush. */
  simTick(turn: TurnSignal): void {
    if (!this.predictor || !this.ready()) return;
    this.clientTicks += 1;
    const seq = this.nextSeq++;
    this.queued.push({ seq, turn });
    this.predictor.applyLocalInput(seq, turn, TICK_DT_SEC);
    this.ticksSinceFlush += 1;
    // Flush on the batch cadence — or immediately when the steer direction
    // changes: turn onsets are what latency is felt on, and they are rare
    // enough to stay well inside the 20:1 message budget (spec §6.3).
    if (this.ticksSinceFlush >= INPUT_FLUSH_TICKS || turn !== this.lastSentTurn) this.flush();
    this.lastSentTurn = turn;
  }

  /**
   * Frame-start housekeeping: decay the correction offsets by the time the
   * PREVIOUS frame was visible. Must run before `advance()`/`receive()` fold
   * new corrections in — decaying a just-created offset would reveal a chunk
   * of it instantly instead of gliding.
   */
  frame(frameDtMs: number): void {
    this.predictor?.decayError(frameDtMs);
  }

  /**
   * Everything the renderer needs, at inter-tick blend factor `alpha`.
   * The enemy timeline advances through a rate-limited follower — after a
   * stall or clock resync it catches up at most twice as fast and never
   * runs backwards, instead of teleporting.
   */
  renderSample(alpha: number, frameDtMs = 50): RenderState {
    let others: SnapshotPlayer[] = [];
    if (this.serverOffset !== null) {
      const delay = INTERP_DELAY_TICKS + this.extraDelayTicks;
      const target = this.clientTicks + alpha + this.serverOffset - delay;
      if (this.renderTick === null || target - this.renderTick > MAX_RENDER_LAG_TICKS) {
        this.renderTick = target;
      } else {
        const maxStep = (Math.min(frameDtMs, TICK_DT_MS) / TICK_DT_MS) * MAX_TIMEWARP;
        this.renderTick += Math.min(Math.max(target - this.renderTick, 0), maxStep);
      }
      // Starvation: the render clock caught the newest snapshot — the enemy
      // would freeze-and-catch-up. Buy more headroom (bursty delivery).
      const newest = this.interpolator.latestTick();
      if (newest !== null && this.renderTick >= newest) {
        if (this.extraDelayTicks < MAX_EXTRA_DELAY_TICKS) this.extraDelayTicks += 1;
        this.lastStarvationTick = this.clientTicks;
      } else if (
        this.extraDelayTicks > 0 &&
        this.clientTicks - this.lastStarvationTick > DELAY_SHRINK_AFTER_TICKS
      ) {
        this.extraDelayTicks -= 1;
        this.lastStarvationTick = this.clientTicks;
      }
      others = this.smoothEnemies(
        this.interpolator.sample(this.renderTick, this.playerId ?? undefined),
        frameDtMs,
      );
    }
    return {
      self: this.predictor?.sample(alpha) ?? null,
      selfBlock: this.selfBlock,
      others,
      arenaSizeWU: this.arenaSizeWU,
    };
  }

  /**
   * Display-side guarantee for enemies (mirrors the own head's glide): the
   * rendered pose follows the interpolated target with bounded speed — a
   * timeline artifact can then never look like a teleport or a whip-around.
   */
  private smoothEnemies(targets: SnapshotPlayer[], frameDtMs: number): SnapshotPlayer[] {
    const dtSec = Math.min(frameDtMs, 100) / 1000;
    const maxMove = BALANCE.movement.speedWuPerSec * MAX_ENEMY_SPEEDUP * dtSec;
    const maxTurn =
      (BALANCE.movement.turnRateDegPerSec * Math.PI * MAX_ENEMY_TURN_SPEEDUP * dtSec) / 180;
    const seen = new Set<number>();
    for (const target of targets) {
      seen.add(target.id);
      const shown = this.enemyPoses.get(target.id);
      if (shown) {
        const dx = target.x - shown.x;
        const dy = target.y - shown.y;
        const dist = Math.hypot(dx, dy);
        if (dist > maxMove && dist <= MAX_ENEMY_GLIDE_WU) {
          target.x = shown.x + (dx / dist) * maxMove;
          target.y = shown.y + (dy / dist) * maxMove;
        }
        const dh = angleDiff(shown.heading, target.heading);
        if (Math.abs(dh) > maxTurn) {
          target.heading = shown.heading + Math.sign(dh) * maxTurn;
        }
      }
      this.enemyPoses.set(target.id, { x: target.x, y: target.y, heading: target.heading });
    }
    for (const id of this.enemyPoses.keys()) {
      if (!seen.has(id)) this.enemyPoses.delete(id);
    }
    return targets;
  }

  private flush(): void {
    this.ticksSinceFlush = 0;
    while (this.queued.length > 0) {
      this.send(encodeInput(this.queued.splice(0, MAX_INPUT_BATCH)));
    }
  }
}
