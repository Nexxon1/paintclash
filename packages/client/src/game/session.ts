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
import {
  BALANCE,
  LIMITS,
  TICK_DT_MS,
  TICK_DT_SEC,
  type Point,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import { pointInTerritory, territoryArea } from '@paintclash/sim-core';

import { angleDiff, Interpolator } from './interpolator.js';
import { Predictor, type RenderPose } from './predictor.js';

/** Sim ticks per batched input frame — the shared §6.3 batching cadence. */
export const INPUT_FLUSH_TICKS = LIMITS.inputFlushTicks;

/**
 * Base delay behind estimated server time for enemy rendering (spec §6.1).
 * 1.5 ticks = 75 ms of headroom on a clean link — deliberately tight, because
 * every tick here is directly visible cross-view offset (ticket 17 measured
 * each interp tick at ~45–50 ms of view lag); bursty links are handled by
 * the ADAPTIVE part: whenever the render clock catches the newest snapshot
 * (starvation = enemy freezes a frame, then catches up), the delay grows; it
 * slowly shrinks again while delivery stays smooth. All well inside the
 * genre's ~500 ms tolerance (spec §6.3). Soak-gated: production PASS with 0
 * frozen frames at this value (2026-07-21).
 */
const INTERP_DELAY_TICKS = 1.5;
const MAX_EXTRA_DELAY_TICKS = 6;
/**
 * One starvation EVENT grows the delay by one — a stall starves several
 * consecutive frames, and without this cooldown a single hiccup would slam
 * the delay to its maximum (and sit there as permanent extra enemy lag).
 */
const DELAY_GROW_COOLDOWN_TICKS = 20; // 1 s
/** Ticks of starvation-free running before the extra delay shrinks by one. */
const DELAY_SHRINK_AFTER_TICKS = 200; // 10 s

/**
 * EMA weight for the server-clock offset. The enemy timeline must advance on
 * the *local* tick clock — pinning it to snapshot arrival times would turn
 * every bit of network jitter into a visible time jump. Samples are
 * quantized to whole ticks, so the weight stays small.
 */
const OFFSET_SMOOTHING = 0.05;

/** An offset this many ticks off is a real clock break — resync hard. */
const OFFSET_RESYNC_TICKS = 10;

/**
 * Minimum advance before a pose joins a trail polyline. Reconciliation
 * wobble (worst against walls) moves the rendered pose back and forth by
 * centimeters — recorded raw, those micro-reversals flip the ribbon's
 * perpendicular and render as a sawtooth. Real movement covers ~0.15 WU
 * per 60 Hz frame, so the gate never coarsens genuine curves.
 */
const MIN_TRAIL_STEP_WU = 0.1;

/**
 * Sim-cadence servo (ticket 17): the tick-mapped input timeline only stays
 * aligned if the client produces one seq per SERVER tick — but the server's
 * real tick rate is not trustworthy 20 Hz (production DOs pace against an
 * isolate clock that measurably runs ~10% off real time). The sim interval
 * steers the smoothed server offset back toward its baseline: per tick of
 * standing error the cadence shifts by SIM_RATE_GAIN, capped via the error
 * clamp at ±15% — beyond that lies a clock break, which resyncs instead.
 */
const SIM_RATE_GAIN = 0.05;
const MAX_SIM_RATE_ERROR_TICKS = 3;

/** Fastest the enemy timeline may run while catching up (2 = double speed). */
const MAX_TIMEWARP = 2;

/**
 * Servo gain for the enemy timeline: per tick of gap to the target, adjust
 * the playback rate by this much. The clock then cruises at 1× and leans
 * gently toward the target instead of copying the target's estimate wobble
 * 1:1 (which showed as constant small enemy speed jitter).
 */
const RENDER_SERVO_GAIN = 0.2;

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

/**
 * Path depth (in WU) a fresh trail is seeded backward into the territory,
 * following the recently rendered path. A single last-inside pose is not
 * enough: at oblique exit angles the ribbon's flat start cap leaves a
 * visible wedge between band and plateau edge — seeding along the real
 * path buries the start well under the plateau for any exit angle.
 */
const TRAIL_SEED_DEPTH_WU = 1.5;

/** Recent-pose ring capacity: covers the seed depth at the 0.1 WU gate. */
const RECENT_POSES_CAP = 24;

/** A trail vertex bound to the server tick it was observed at. */
interface StampedPoint {
  tick: number;
  point: Point;
  /** Lies over foreign territory — drawn on top of the plateau (interim). */
  lift?: boolean;
}

/** A recorded trail vertex; `lift` = it lies over foreign territory. */
interface TrailPoint {
  point: Point;
  lift: boolean;
}

/** One player's territory for rendering; `rev` bumps on every replacement. */
export interface TerritoryView {
  playerId: number;
  territory: Territory;
  /** Monotonic per-player revision — the scene rebuilds meshes on change. */
  rev: number;
}

export interface RenderState {
  self: RenderPose | null;
  /** Own player id, once welcomed — keys the own entries below. */
  selfId: number | null;
  others: SnapshotPlayer[];
  arenaSizeWU: number | null;
  /** Every known territory, own included (ticket 04). */
  territories: TerritoryView[];
  /**
   * Trail polylines to draw (ticket 04), each ending at its player's
   * rendered head: the own one from rendered frame poses, enemy ones from
   * snapshot poses held back to the enemy render timeline. `lifts[i]` marks
   * points over foreign territory — drawn on top of the plateau there
   * (interim until ticket 06's carve-through groove).
   */
  trails: { playerId: number; points: Point[]; lifts: boolean[] }[];
  /** Players whose fill landed since the last sample (wave animation). */
  fills: number[];
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
  /** Latest known territory + revision per player (server-only truth, §6.1). */
  private readonly territories = new Map<number, TerritoryView>();
  /** Fill events since the last renderSample (drained there). */
  private pendingFills: number[] = [];
  /**
   * Own trail from RENDERED frame poses (not tick poses) — appended in
   * renderSample, so the ribbon is by construction exactly as smooth as the
   * head on screen: tick-pose vertices would click at 20 Hz through turns
   * and the bridge to the interpolated head would fold back on itself every
   * tick (visible tip flicker). Cleared by the own fill message. The live
   * head pose itself is appended at sample time, never stored — the stored
   * points always lie behind it, so the ribbon tip stays glued to the head
   * without the 0.1 WU gate quantizing it.
   */
  private ownTrail: TrailPoint[] = [];
  /** Recent rendered poses — a fresh trail is seeded backward from these. */
  private readonly ownRecent: Point[] = [];
  /** Enemy trails from snapshot poses, tick-stamped for the render timeline. */
  private readonly enemyTrails = new Map<number, StampedPoint[]>();
  /** Recent snapshot poses per enemy — seed a starting trail backward. */
  private readonly enemyRecent = new Map<number, StampedPoint[]>();
  /** Local sim ticks since start — the smooth clock everything renders on. */
  private clientTicks = 0;
  /** Turn value of the last flushed tick — direction changes flush eagerly. */
  private lastSentTurn: TurnSignal = 0;
  /** EMA of (server tick − local tick); null until the first snapshot. */
  private serverOffset: number | null = null;
  /** Offset level the sim cadence steers back toward (see SIM_RATE_GAIN). */
  private offsetBaseline: number | null = null;
  /** Rate-limited enemy timeline (see renderSample). */
  private renderTick: number | null = null;
  /** Adaptive addition to INTERP_DELAY_TICKS (starvation-driven). */
  private extraDelayTicks = 0;
  /** Local tick of the last starvation (or last shrink step). */
  private lastStarvationTick = 0;
  /** Local tick of the last delay growth — one event per cooldown window. */
  private lastDelayGrowTick = Number.NEGATIVE_INFINITY;
  /** Local tick when the last fresh snapshot arrived (outage detection). */
  private lastSnapshotClientTick = 0;
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
    if (message.type === 'territory') {
      const previous = this.territories.get(message.playerId);
      this.territories.set(message.playerId, {
        playerId: message.playerId,
        territory: message.territory,
        rev: (previous?.rev ?? 0) + 1,
      });
      if (message.reason === 'fill') {
        // A fill ends the trail that drew it (spec §2.2) — authoritative,
        // never inferred from poses.
        if (message.playerId === this.playerId) this.ownTrail = [];
        else this.enemyTrails.delete(message.playerId);
        // Animate only real growth — a discarded sliver loop (spec §2.2
        // floor) still clears the trail but earns no wave.
        const grew =
          previous === undefined ||
          territoryArea(message.territory) > territoryArea(previous.territory) + 1e-9;
        if (grew) this.pendingFills.push(message.playerId);
      }
      return;
    }
    if (message.type === 'trail') {
      // Join-time full sync of a standing trail. No tick stamps on the wire:
      // stamp 0 renders the whole history immediately, appends stamp on.
      if (message.playerId !== this.playerId) {
        this.enemyTrails.set(
          message.playerId,
          message.points.map((point) => ({
            tick: 0,
            point,
            lift: this.overForeignLand(point[0], point[1], message.playerId),
          })),
        );
      }
      return;
    }
    const latest = this.interpolator.latestTick();
    if (latest !== null && message.tick <= latest) return;
    this.interpolator.add(message.tick, message.players);
    this.trackEnemyTrails(message.tick, message.players);
    this.lastSnapshotClientTick = this.clientTicks;
    const offsetSample = message.tick - this.clientTicks;
    if (
      this.serverOffset === null ||
      Math.abs(offsetSample - this.serverOffset) > OFFSET_RESYNC_TICKS
    ) {
      // Clock break (first contact, hidden tab, arena reset): adopt the new
      // level — chasing it with the rate servo would take forever.
      this.serverOffset = offsetSample;
      this.offsetBaseline = offsetSample;
    } else {
      this.serverOffset += OFFSET_SMOOTHING * (offsetSample - this.serverOffset);
    }
    const self =
      this.playerId === null ? undefined : message.players.find((p) => p.id === this.playerId);
    if (self && this.predictor) {
      this.predictor.reconcile(self, message.ackSeq, TICK_DT_SEC);
    }
  }

  /**
   * Derive enemy trails from the poses every snapshot already carries — the
   * same rule the sim runs (outside the own territory ⇒ the pose extends the
   * trail, seeded with the last inside pose), so no extra wire traffic is
   * needed. Clearing is never inferred: only the fill message ends a trail.
   */
  private trackEnemyTrails(tick: number, players: SnapshotPlayer[]): void {
    const present = new Set<number>();
    for (const p of players) {
      present.add(p.id);
      if (p.id === this.playerId) continue;
      const territory = this.territories.get(p.id)?.territory;
      const point: Point = [p.x, p.y];
      // Before the territory sync lands there is no reliable inside-test —
      // and no trail either (the sync precedes the first pose, ticket 04).
      if (territory && !pointInTerritory(p.x, p.y, territory)) {
        let trail = this.enemyTrails.get(p.id);
        if (!trail || trail.length === 0) {
          // Seed backward along the recent path while it stays inside the
          // territory — buried under the plateau for any exit angle.
          trail = this.seedFromRecent(this.enemyRecent.get(p.id) ?? [], territory);
          this.enemyTrails.set(p.id, trail);
        }
        const last = trail[trail.length - 1];
        // Corner-pinned poses barely move — skip sub-step points (they
        // degenerate the ribbon), but a lone seed still gets its partner.
        if (
          !last ||
          Math.hypot(point[0] - last.point[0], point[1] - last.point[1]) >= MIN_TRAIL_STEP_WU
        ) {
          trail.push({ tick, point, lift: this.overForeignLand(point[0], point[1], p.id) });
        }
      }
      this.pushRecent(p.id, tick, point);
    }
    // Players gone from the snapshot left the arena; their land is neutral.
    for (const map of [this.territories, this.enemyTrails, this.enemyRecent] as const) {
      for (const id of map.keys()) {
        if (!present.has(id) && id !== this.playerId) map.delete(id);
      }
    }
  }

  /** Record one enemy pose in its recent-path ring (gated like trails). */
  private pushRecent(id: number, tick: number, point: Point): void {
    let recent = this.enemyRecent.get(id);
    if (!recent) {
      recent = [];
      this.enemyRecent.set(id, recent);
    }
    const last = recent[recent.length - 1];
    if (
      last &&
      Math.hypot(point[0] - last.point[0], point[1] - last.point[1]) < MIN_TRAIL_STEP_WU
    ) {
      return;
    }
    recent.push({ tick, point });
    if (recent.length > RECENT_POSES_CAP) recent.shift();
  }

  /**
   * Walk a recent-path ring backward and keep the tail that is still inside
   * `territory`, up to TRAIL_SEED_DEPTH_WU of path length — the under-the-
   * plateau start of a fresh trail (oldest first).
   */
  private seedFromRecent(recent: readonly StampedPoint[], territory: Territory): StampedPoint[] {
    const seed: StampedPoint[] = [];
    let depth = 0;
    let prev: Point | null = null;
    for (let i = recent.length - 1; i >= 0; i--) {
      const entry = recent[i];
      if (!entry || !pointInTerritory(entry.point[0], entry.point[1], territory)) break;
      if (prev) depth += Math.hypot(entry.point[0] - prev[0], entry.point[1] - prev[1]);
      if (depth > TRAIL_SEED_DEPTH_WU) break;
      seed.unshift(entry);
      prev = entry.point;
    }
    return seed;
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
   * Wall-clock milliseconds the driving loop should allot per sim tick —
   * nominal 50 ms, servo-shifted so the local tick (and with it the seq
   * timeline) runs at the server's REAL rate, whatever its clock thinks.
   */
  simIntervalMs(): number {
    if (this.serverOffset === null || this.offsetBaseline === null) return TICK_DT_MS;
    const error = Math.min(
      MAX_SIM_RATE_ERROR_TICKS,
      Math.max(-MAX_SIM_RATE_ERROR_TICKS, this.serverOffset - this.offsetBaseline),
    );
    return TICK_DT_MS / (1 + SIM_RATE_GAIN * error);
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
      if (this.renderTick === null || Math.abs(target - this.renderTick) > MAX_RENDER_LAG_TICKS) {
        // Way behind (stall) or way ahead (post-outage resync dropped the
        // target): snap once — the servo would take seconds either way.
        this.renderTick = target;
      } else {
        // Servo: cruise at 1× real time, lean toward the target — never
        // backwards, at most MAX_TIMEWARP while catching up.
        const dtTicks = Math.min(frameDtMs, TICK_DT_MS) / TICK_DT_MS;
        const gap = target - this.renderTick;
        const rate = Math.min(Math.max(1 + RENDER_SERVO_GAIN * gap, 0), MAX_TIMEWARP);
        this.renderTick += dtTicks * rate;
      }
      // Starvation: the render clock caught the newest snapshot — the enemy
      // would freeze-and-catch-up. Buy more headroom (bursty delivery) —
      // but only while data is actually flowing: a full outage would
      // otherwise pump the delay to its maximum for nothing.
      const newest = this.interpolator.latestTick();
      const dataFlowing =
        this.clientTicks - this.lastSnapshotClientTick <= DELAY_GROW_COOLDOWN_TICKS / 2;
      if (newest !== null && this.renderTick >= newest) {
        if (
          dataFlowing &&
          this.extraDelayTicks < MAX_EXTRA_DELAY_TICKS &&
          this.clientTicks - this.lastDelayGrowTick >= DELAY_GROW_COOLDOWN_TICKS
        ) {
          this.extraDelayTicks += 1;
          this.lastDelayGrowTick = this.clientTicks;
        }
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
    const self = this.predictor?.sample(alpha) ?? null;
    this.trackOwnTrail(self);
    const fills = this.pendingFills;
    this.pendingFills = [];
    return {
      self,
      selfId: this.playerId,
      others,
      arenaSizeWU: this.arenaSizeWU,
      territories: [...this.territories.values()],
      trails: this.sampleTrails(self, others),
      fills,
    };
  }

  /** Is this point on land owned by anyone but `exceptId`? (lift flag) */
  private overForeignLand(x: number, y: number, exceptId: number): boolean {
    for (const view of this.territories.values()) {
      if (view.playerId === exceptId) continue;
      if (pointInTerritory(x, y, view.territory)) return true;
    }
    return false;
  }

  /**
   * Extend the own trail with the pose actually drawn this frame. Outside
   * the own territory every rendered pose joins the ribbon (collinear runs
   * compact away, sub-step wobble is gated); a fresh trail is seeded
   * backward along the recently rendered path while it stays inside the
   * territory, so the ribbon start is buried under the plateau for any
   * exit angle (same rule as the enemy derivation).
   */
  private trackOwnTrail(self: RenderPose | null): void {
    if (!self || this.playerId === null) return;
    const own = this.territories.get(this.playerId);
    if (!own) return;
    if (!pointInTerritory(self.x, self.y, own.territory)) {
      if (this.ownTrail.length === 0) {
        this.ownTrail = this.seedFromRecent(
          this.ownRecent.map((point): StampedPoint => ({ tick: 0, point })),
          own.territory,
        ).map(({ point }): TrailPoint => ({ point, lift: false }));
      }
      const last = this.ownTrail[this.ownTrail.length - 1];
      // Sub-step gate: reconciliation wobble must not etch a sawtooth into
      // the ribbon (see MIN_TRAIL_STEP_WU). The live head pose is appended
      // at sample time instead — the tip never lags behind the gate.
      if (
        !last ||
        Math.hypot(self.x - last.point[0], self.y - last.point[1]) >= MIN_TRAIL_STEP_WU
      ) {
        this.pushOwnPoint([self.x, self.y], this.overForeignLand(self.x, self.y, this.playerId));
      }
    }
    const lastRecent = this.ownRecent[this.ownRecent.length - 1];
    if (
      !lastRecent ||
      Math.hypot(self.x - lastRecent[0], self.y - lastRecent[1]) >= MIN_TRAIL_STEP_WU
    ) {
      this.ownRecent.push([self.x, self.y]);
      if (this.ownRecent.length > RECENT_POSES_CAP) this.ownRecent.shift();
    }
  }

  /**
   * Append one own-trail vertex, merging exactly-collinear forward motion
   * into one segment (mirrors sim-core's appendTrailPoint) so straight
   * cruising stays O(1) points instead of one vertex per 0.1 WU.
   */
  private pushOwnPoint(point: Point, lift: boolean): void {
    const last = this.ownTrail[this.ownTrail.length - 1];
    const beforeLast = this.ownTrail[this.ownTrail.length - 2];
    if (last && beforeLast && last.lift === lift && beforeLast.lift === lift) {
      const ax = last.point[0] - beforeLast.point[0];
      const ay = last.point[1] - beforeLast.point[1];
      const bx = point[0] - last.point[0];
      const by = point[1] - last.point[1];
      if (ax * bx + ay * by > 0 && Math.abs(ax * by - ay * bx) < 1e-9) {
        last.point = point;
        return;
      }
    }
    this.ownTrail.push({ point, lift });
  }

  /**
   * Trail polylines for this frame, each ending in the player's LIVE
   * rendered head pose (appended here, never stored — the tip stays glued
   * to the head every frame, whatever the point gate kept). Enemy trails
   * only reveal stored points up to the enemy render timeline (they'd lead
   * their delayed heads otherwise).
   */
  private sampleTrails(self: RenderPose | null, others: SnapshotPlayer[]): RenderState['trails'] {
    const trails: RenderState['trails'] = [];
    if (self && this.playerId !== null && this.ownTrail.length >= 1) {
      const points = this.ownTrail.map(({ point }): Point => [point[0], point[1]]);
      const lifts = this.ownTrail.map(({ lift }) => lift);
      points.push([self.x, self.y]);
      lifts.push(this.overForeignLand(self.x, self.y, this.playerId));
      if (points.length >= 2) trails.push({ playerId: this.playerId, points, lifts });
    }
    for (const enemy of others) {
      const stamped = this.enemyTrails.get(enemy.id);
      if (!stamped || stamped.length === 0) continue;
      const points: Point[] = [];
      const lifts: boolean[] = [];
      for (const { tick, point, lift } of stamped) {
        if (this.renderTick !== null && tick > this.renderTick) break;
        points.push([point[0], point[1]]);
        lifts.push(lift ?? false);
      }
      points.push([enemy.x, enemy.y]);
      lifts.push(this.overForeignLand(enemy.x, enemy.y, enemy.id));
      if (points.length >= 2) trails.push({ playerId: enemy.id, points, lifts });
    }
    return trails;
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
        if (dist <= MAX_ENEMY_GLIDE_WU) {
          if (dist > maxMove) {
            target.x = shown.x + (dx / dist) * maxMove;
            target.y = shown.y + (dy / dist) * maxMove;
          }
          const dh = angleDiff(shown.heading, target.heading);
          if (Math.abs(dh) > maxTurn) {
            target.heading = shown.heading + Math.sign(dh) * maxTurn;
          }
        }
        // Teleport-grade distance (a future respawn): snap position AND
        // heading — rate-limiting only the heading would render the body
        // driving sideways at the new spot.
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
