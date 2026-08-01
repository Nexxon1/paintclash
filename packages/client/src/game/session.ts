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
  encodeRoomSettings,
  encodeRoomStart,
  MAX_INPUT_BATCH,
  type DeathCause,
  type InputItem,
  type LeaderboardRow,
  type LobbyState,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import {
  BALANCE,
  LIMITS,
  TICK_DT_MS,
  TICK_DT_SEC,
  type LifeCounters,
  type Point,
  type RoomConfig,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import {
  distanceToTerritory,
  lifeScore,
  pointInTerritory,
  territoryArea,
} from '@paintclash/sim-core';

import { angleDiff, Interpolator } from './interpolator.js';
import { Predictor, type RenderPose } from './predictor.js';

import type { FinishedLife } from './records.js';

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
 * How far clear of its own land the head must get for the OWN ribbon to be
 * drawn even while the loop closes are earning nothing (ticket 20).
 *
 * This is the override, not the rule: the rule is whether the last loop close
 * earned land (see `lastCloseEarnedLand`). What the override buys is the short
 * trail that claims real ground while the streak is still cold — a run across a
 * GAP in the own territory, or the first circle of the reported gesture when it
 * is thrown from the block's edge rather than its centre. Waiting for the fill
 * to prove those would hide them for exactly the fraction of a second in which
 * the player is looking for the line.
 *
 * The threshold is one MIN_TRAIL_STEP_WU, and that is the whole argument: it is
 * this file's existing yardstick for "the head has really moved rather than
 * wobbled", so a head one step clear of its own land is out there in the same
 * sense. Two measurements bound it from either side.
 *
 * Below — it must never fire on the graze. Against the real sim, one steer key
 * held for 20 s, clearance = `distanceToTerritory`:
 *
 * | circle started at | max clearance while EARNING | while BARREN |
 * | --- | --- | --- |
 * | the block's centre | 0.2137 WU | **0.0157 WU** |
 * | the block's edge | 1.2907 WU | **0.0000 WU** |
 * | just outside the edge | 1.8907 WU | **0.0157 WU** |
 *
 * The barren steady state — the state the report is about — never gets a
 * sixtieth of a ribbon width out, so this sits 6.4× above it, and above the
 * reconciliation wobble that moves the RENDERED pose off the sim's by less than
 * one step gate by construction.
 *
 * Above — a gap of width W tops out at W/2 of clearance in its middle, so this
 * threshold is also the statement "gaps down to 0.2 WU reveal their ribbon".
 * That matters: at half a ribbon width (the first draft of this constant) gaps
 * of 0.6–1.0 WU never revealed at all, which is the case the ticket's addendum
 * was written against. Anything narrower than 0.2 WU is a hairline crack no
 * player is aiming at, and it still shows its ribbon the moment the fill lands.
 */
export const OWN_TRAIL_REVEAL_CLEARANCE_WU = MIN_TRAIL_STEP_WU;

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
}

/** One death event, surfaced to the renderer/sound seam (ticket 05/11). */
export interface DeathView {
  victimId: number;
  killerId: number;
  cause: DeathCause;
}

/** One player's territory for rendering; `rev` bumps on every replacement. */
export interface TerritoryView {
  playerId: number;
  territory: Territory;
  /** Monotonic per-player revision — the scene rebuilds meshes on change. */
  rev: number;
}

/**
 * One player's trail polyline for this frame (ticket 04), ending at their
 * rendered head: the own one from rendered frame poses, enemy ones from
 * snapshot poses held back to the enemy render timeline. Over foreign plateaus
 * the scene carves a ground-level groove along the same polyline (ticket 06) —
 * the ribbon always hugs the floor.
 */
export interface TrailView {
  playerId: number;
  points: Point[];
  /**
   * Should this be DRAWN? Not whether it exists (ticket 20): the graze carved
   * by circling on ground you already own is still listed, because it is still
   * there and its owner is still cuttable on it. The scene skips ribbon and
   * groove for those; anything reasoning about what the player is DOING — the
   * eat loop, say — reads the list itself. Enemy trails are always visible:
   * hiding one would hide THEIR vulnerability from the player who could cut
   * it, which is a rule change and not polish.
   */
  visible: boolean;
}

/**
 * The global ranking as last received (ticket 08, spec §2.5). `rev` bumps per
 * board, so the DOM HUD rebuilds on change instead of every frame.
 */
export interface LeaderboardView {
  rev: number;
  rows: readonly LeaderboardRow[];
}

/**
 * The private room's lobby as last received (ticket 14, spec §2.6), with a
 * revision so the card rebuilds on change instead of every frame — the same
 * contract the leaderboard has. Null in the public arena, and from the welcome
 * on: a lobby is what a client has INSTEAD of a game.
 */
export interface LobbyView {
  rev: number;
  lobby: LobbyState;
}

export interface RenderState {
  self: RenderPose | null;
  /** Own player id, once welcomed — keys the own entries below. */
  selfId: number | null;
  others: SnapshotPlayer[];
  arenaSizeWU: number | null;
  /** Every known territory, own included (ticket 04). */
  territories: TerritoryView[];
  /** Every trail to reason about this frame, own included (ticket 04). */
  trails: TrailView[];
  /** Players whose fill landed since the last sample (wave animation). */
  fills: number[];
  /**
   * Deaths since the last sample (ticket 05). Deliberately plain for now:
   * the territory turning neutral + the pose cut ARE the death visuals;
   * this is the seam for sound (ticket 11) and later flourish.
   */
  deaths: DeathView[];
  /** Top rows + the own one, straight from the server (ticket 08). */
  leaderboard: LeaderboardView;
  /**
   * The own score as it stands (ticket 09, spec §2.5) — null until the first
   * score frame arrives, which is what hides the panel before the spawn.
   */
  liveScore: number | null;
  /**
   * The own life that ended since the last sample: what the local records are
   * committed from (ADR-0006 seam 4). Drained like `deaths`.
   */
  finishedLife: FinishedLife | null;
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
  /** Death events since the last renderSample (drained there). */
  private pendingDeaths: DeathView[] = [];
  /** Latest global ranking; stands until the next board replaces it. */
  private leaderboard: LeaderboardView = { rev: 0, rows: [] };
  /** The room's lobby while waiting for the host to start (ticket 14). */
  private lobby: LobbyView | null = null;
  /**
   * Newest own-score ingredients from the server (ticket 09), plus the local
   * tick they arrived at: between frames only the survival term advances, so
   * the HUD number climbs smoothly instead of stepping twice a second — and
   * it stays ANCHORED to the server rather than accumulating error.
   */
  private scoreAnchor: LifeCounters | null = null;
  private scoreAnchorTick = 0;
  /** The own life closed since the last renderSample (drained there). */
  private pendingFinishedLife: FinishedLife | null = null;
  /** The own death's respawn must CUT, not glide — set until reconciled. */
  private snapOnReconcile = false;
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
  private ownTrail: Point[] = [];
  /**
   * Did the last own loop close gain land (ticket 20)? That single bit is what
   * separates the two things a short own trail can be, and it is the one thing
   * a threshold on length or depth cannot read:
   *
   * - Circling at the own edge to claim ground EARNS on its first revolutions
   *   and then, once the territory has healed onto the circle, earns nothing
   *   on every revolution after — while still carving a real trail each time.
   *   That endless second half is the reported flicker.
   * - Every deliberate loop — a raid, a gap crossing, a shallow one hugged
   *   along the own edge — earns. So one earning close is enough to hand the
   *   ribbon back, and the gate switches itself off the moment land flows
   *   again. It needs no timer and no budget that could creep up over a life.
   *
   * True at spawn and after a death: a fresh life's first trail is drawn.
   */
  private lastCloseEarnedLand = true;
  /**
   * Has THIS excursion earned its way onto the screen (ticket 20)? Sticky
   * until the trail ends: re-hiding a ribbon mid-run would be a worse flicker
   * than the one this gate removes. Only consulted while still hidden, so the
   * point-to-territory sweep stops running once the verdict has fallen.
   */
  private ownTrailRevealed = false;
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

  /**
   * The own head's heading as the sim currently has it — what the aiming
   * control modes steer FROM (spec §3); null before the spawn.
   *
   * The predicted tick pose, not the rendered one: the intent is applied to the
   * next sim tick, while the rendered heading is that same pose plus a decaying
   * correction glide. Position never enters into it — the camera holds the head
   * at the screen center, so a pointer's offset from the center IS its offset
   * from the head (see `game/camera.ts`).
   */
  headHeading(): number | null {
    return this.predictor?.current()?.heading ?? null;
  }

  /**
   * The room's lobby, or null when there is none to show (the public arena, or a
   * game already running). Pulled once per frame by `main.ts`, like the board.
   */
  lobbyView(): LobbyView | null {
    return this.lobby;
  }

  /** Ask the room for these settings — the server obeys only the host. */
  sendRoomSettings(config: RoomConfig): void {
    this.send(encodeRoomSettings(config));
  }

  /** Start the game (spec §2.6: Host-Start) — the server obeys only the host. */
  sendRoomStart(): void {
    this.send(encodeRoomStart());
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
      // The game started (or this was the public arena all along): the lobby is
      // over, and the ids in it were lobby-local — the welcome's id is the real
      // one from here on.
      this.lobby = null;
      return;
    }
    if (message.type === 'lobby') {
      const { code, config, selfId, members } = message;
      this.lobby = {
        rev: (this.lobby?.rev ?? 0) + 1,
        lobby: { code, config, selfId, members },
      };
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
        // Did this close actually gain ground? A discarded sliver loop (spec
        // §2.2 floor) still clears the trail but earns no wave — and, since
        // ticket 20, no ribbon on the next graze either.
        const grew =
          previous === undefined ||
          territoryArea(message.territory) > territoryArea(previous.territory) + 1e-9;
        // A fill ends the trail that drew it (spec §2.2) — authoritative,
        // never inferred from poses.
        if (message.playerId === this.playerId) {
          this.clearOwnTrail();
          this.lastCloseEarnedLand = grew;
        } else {
          this.enemyTrails.delete(message.playerId);
        }
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
          message.points.map((point) => ({ tick: 0, point })),
        );
      }
      return;
    }
    if (message.type === 'death') {
      // The trail died with the player — authoritative, like the fill's
      // clear. The respawn block (territory sync) and pose (snapshot)
      // follow in the same tick's frames.
      if (message.victimId === this.playerId) {
        this.clearOwnTrail();
        this.ownRecent.length = 0;
        this.snapOnReconcile = true;
        // A new life starts owing nothing: its first trail is drawn (ticket 20).
        this.lastCloseEarnedLand = true;
        // The score died with the life (ticket 09): zero the anchor in place,
        // so the panel reads the fresh life's 0 and climbs instead of blinking
        // out for the half second until the next live frame re-anchors it.
        // The company average carries over — it is the only term the new life
        // inherits, and the server's next frame corrects it anyway.
        this.scoreAnchor = {
          peakPct: 0,
          lifeTicks: 0,
          avgOtherHumans: this.scoreAnchor?.avgOtherHumans ?? 0,
        };
        this.scoreAnchorTick = this.clientTicks;
      } else {
        this.enemyTrails.delete(message.victimId);
        this.enemyRecent.delete(message.victimId);
        // Forget the shown pose too: the respawn teleport must cut, not
        // rubber-band across the arena at glide speed.
        this.enemyPoses.delete(message.victimId);
      }
      this.pendingDeaths.push({
        victimId: message.victimId,
        killerId: message.killerId,
        cause: message.cause,
      });
      return;
    }
    if (message.type === 'leaderboard') {
      // Boards replace, never merge (spec §2.5) — the server sends one only
      // when it changed, so a bumped rev always means a real change.
      this.leaderboard = { rev: this.leaderboard.rev + 1, rows: message.rows };
      return;
    }
    if (message.type === 'score') {
      const { peakPct, lifeTicks, avgOtherHumans } = message;
      if (message.final) {
        // The life's last word (spec §2.5: the score is computed at death) —
        // the same formula the live estimate uses, on the closing counters.
        const survivalSec = lifeTicks * TICK_DT_SEC;
        this.pendingFinishedLife = {
          score: lifeScore({ peakPct, survivalSec, avgOtherHumans }),
          peakPct,
          survivalSec,
        };
        return;
      }
      this.scoreAnchor = { peakPct, lifeTicks, avgOtherHumans };
      this.scoreAnchorTick = this.clientTicks;
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
      if (this.snapOnReconcile) {
        // First authoritative pose after the own death: the respawn.
        this.predictor.snap();
        this.snapOnReconcile = false;
      }
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
          trail.push({ tick, point });
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
    const deaths = this.pendingDeaths;
    this.pendingDeaths = [];
    const finishedLife = this.pendingFinishedLife;
    this.pendingFinishedLife = null;
    return {
      self,
      selfId: this.playerId,
      others,
      arenaSizeWU: this.arenaSizeWU,
      territories: [...this.territories.values()],
      trails: this.sampleTrails(self, others),
      fills,
      deaths,
      leaderboard: this.leaderboard,
      liveScore: this.liveScore(),
      finishedLife,
    };
  }

  /**
   * The own score as it stands (spec §2.5: live estimate, identical formula).
   * The server's ingredients are anchored on arrival; between frames only the
   * survival time advances — on the local tick clock, which is servoed to the
   * server's real rate, so the estimate cannot drift away from the number the
   * final frame will report.
   */
  private liveScore(): number | null {
    return this.currentLife()?.score ?? null;
  }

  /**
   * The running life as it stands — the same numbers the `final` frame would
   * carry, from the anchor plus the ticks lived since it arrived. Null before
   * the first score frame.
   *
   * `main.ts` commits this when the session ends WITHOUT a death (the socket
   * dropped, the player closed the game): a life that was actually played must
   * be able to set the max-% and survival records, which otherwise only a
   * death could (spec §2.5 lists them as records, not as death scores). The
   * numbers are a lower bound — at most one score interval stale — and
   * committing keeps only maxima, so a double commit is harmless.
   */
  currentLife(): FinishedLife | null {
    const anchor = this.scoreAnchor;
    if (!anchor) return null;
    const ticks = anchor.lifeTicks + Math.max(0, this.clientTicks - this.scoreAnchorTick);
    const survivalSec = ticks * TICK_DT_SEC;
    return {
      score: lifeScore({
        peakPct: anchor.peakPct,
        survivalSec,
        avgOtherHumans: anchor.avgOtherHumans,
      }),
      peakPct: anchor.peakPct,
      survivalSec,
    };
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
        ).map(({ point }) => point);
      }
      const last = this.ownTrail[this.ownTrail.length - 1];
      // Sub-step gate: reconciliation wobble must not etch a sawtooth into
      // the ribbon (see MIN_TRAIL_STEP_WU). The live head pose is appended
      // at sample time instead — the tip never lags behind the gate.
      if (!last || Math.hypot(self.x - last[0], self.y - last[1]) >= MIN_TRAIL_STEP_WU) {
        this.pushOwnPoint([self.x, self.y]);
      }
      // Ticket 20: draw the ribbon while the loop closes are still earning
      // land, and otherwise only once the head is a half ribbon width clear of
      // its own edge. Both are checked per frame while hidden and then stick.
      this.ownTrailRevealed ||=
        this.lastCloseEarnedLand ||
        distanceToTerritory(self.x, self.y, own.territory) >= OWN_TRAIL_REVEAL_CLEARANCE_WU;
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
   * End the own trail: the polyline and, with it, this excursion's drawing
   * verdict (ticket 20 — a revealed run says nothing about the next one).
   */
  private clearOwnTrail(): void {
    this.ownTrail = [];
    this.ownTrailRevealed = false;
  }

  /**
   * Append one own-trail vertex, merging exactly-collinear forward motion
   * into one segment (mirrors sim-core's appendTrailPoint) so straight
   * cruising stays O(1) points instead of one vertex per 0.1 WU.
   */
  private pushOwnPoint(point: Point): void {
    const last = this.ownTrail[this.ownTrail.length - 1];
    const beforeLast = this.ownTrail[this.ownTrail.length - 2];
    if (last && beforeLast) {
      const ax = last[0] - beforeLast[0];
      const ay = last[1] - beforeLast[1];
      const bx = point[0] - last[0];
      const by = point[1] - last[1];
      if (ax * bx + ay * by > 0 && Math.abs(ax * by - ay * bx) < 1e-9) {
        last[0] = point[0];
        last[1] = point[1];
        return;
      }
    }
    this.ownTrail.push(point);
  }

  /**
   * Trail polylines for this frame, each ending in the player's LIVE
   * rendered head pose (appended here, never stored — the tip stays glued
   * to the head every frame, whatever the point gate kept). Enemy trails
   * only reveal stored points up to the enemy render timeline (they'd lead
   * their delayed heads otherwise).
   */
  private sampleTrails(self: RenderPose | null, others: SnapshotPlayer[]): TrailView[] {
    const trails: TrailView[] = [];
    if (self && this.playerId !== null && this.ownTrail.length >= 1) {
      const points = this.ownTrail.map((point): Point => [point[0], point[1]]);
      points.push([self.x, self.y]);
      if (points.length >= 2) {
        trails.push({ playerId: this.playerId, points, visible: this.ownTrailRevealed });
      }
    }
    for (const enemy of others) {
      const stamped = this.enemyTrails.get(enemy.id);
      if (!stamped || stamped.length === 0) continue;
      const points: Point[] = [];
      for (const { tick, point } of stamped) {
        if (this.renderTick !== null && tick > this.renderTick) break;
        points.push([point[0], point[1]]);
      }
      points.push([enemy.x, enemy.y]);
      if (points.length >= 2) trails.push({ playerId: enemy.id, points, visible: true });
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

  /**
   * The server tick this client currently RENDERS opponents at — reported
   * with every input frame so kill judgment can rewind to what the pilot
   * actually saw (ticket 07). The enemy timeline (`renderTick`) is exactly
   * that view; 0 = no snapshot rendered yet.
   */
  private viewTick(): number {
    if (this.renderTick === null) return 0;
    return Math.max(0, Math.round(this.renderTick));
  }

  private flush(): void {
    this.ticksSinceFlush = 0;
    while (this.queued.length > 0) {
      this.send(encodeInput(this.queued.splice(0, MAX_INPUT_BATCH), this.viewTick()));
    }
  }
}
