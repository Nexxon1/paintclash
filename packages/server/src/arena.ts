/**
 * ArenaCore — the authoritative arena brain, free of any Durable Object API
 * so every rule is unit-testable in plain node (spec §9.1). The DO shell
 * (`arena-do.ts`) owns transport + 20 Hz pacing and delegates everything else
 * here.
 *
 * Trust boundary (spec §8.2): clients speak *only* via `handleFrame`, which
 * decodes, validates and queues steer intents. Positions are re-derived from
 * `sim-core` every tick — nothing a client sends can express position,
 * speed, or another player's id. The one piece of client-supplied *content*
 * that reaches other players is the nickname, and it passes the shared policy
 * here before it is stored (spec §8.3 point 5, ticket 13).
 *
 * Input timeline (ticket 17, tick-mapped): a client samples one intent per
 * sim tick, `seq` IS its sim-tick counter. Per connection the server tracks
 * `tickOffset` so that seq `s` maps to server tick `s + tickOffset`; each
 * tick applies exactly the input mapped to it. A missing input (still in
 * flight) persists the current turn and the tick still counts as processed —
 * the ack is "processed through", not "applied" — so the client's replay of
 * `seq > ack` reconstructs the server timeline exactly, with zero jitter
 * buffer and zero standing backlog. Inputs arriving after their mapped tick
 * ran are dropped (applying them would double-simulate the past); the drift
 * servo below keeps that rare. Queue overflow beyond
 * `LIMITS.maxPendingInputs` is flood; the oldest entries drop (spec §8.3).
 */

import {
  decodeClientMessage,
  encodeDeath,
  encodeLeaderboard,
  encodeScore,
  encodeSnapshot,
  encodeTerritory,
  encodeTrail,
  encodeWelcome,
  type InputItem,
  type LeaderboardRow,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import { BALANCE, LIMITS, checkNickname, type TurnSignal } from '@paintclash/shared';
import {
  createSimState,
  lifeStats,
  standings,
  step,
  type SimState,
  type Standing,
} from '@paintclash/sim-core';

import { BotPilot, senseFor } from './bot.js';

/** What ArenaCore needs from a transport — a DO WebSocket satisfies this. */
export interface ArenaSocket {
  send(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Neutral start of the smoothed arrival margin: mid-band, so the servo
 * neither slackens nor tightens before real samples arrive.
 */
const MARGIN_EMA_START = (LIMITS.tickMapMinMarginTicks + LIMITS.tickMapMaxMarginTicks) / 2;

/**
 * Auto guest name for a client whose name did not survive the policy (spec
 * §2.8: "Leerer Name → Auto-Gastname (Gast-####)") — the leaderboard must not
 * render a blank row, and one shared "Gast" for everyone would be no name at
 * all. Numbered by player id, which every row carries anyway.
 */
function guestName(playerId: number): string {
  return `Gast-${String(playerId).padStart(4, '0')}`;
}

/**
 * The display name this connection gets (ticket 13, spec §2.8/§8.3 point 5).
 *
 * This is the **enforcement** point: the client runs the very same
 * `checkNickname` as a UX pre-check, but nothing it says is trusted — a
 * hand-crafted join frame carrying a blocked name, control characters or a
 * zero-width-padded blank reaches exactly this line and is answered with a
 * guest name. A rejection is silent on purpose: the name is cosmetic, and
 * refusing the join over one would cost a player their game for nothing.
 */
function displayName(requested: string, playerId: number): string {
  const verdict = checkNickname(requested);
  return verdict.ok ? verdict.name : guestName(playerId);
}

interface Connection {
  socket: ArenaSocket;
  /** Display name from the join — shown on the leaderboard (spec §2.5). */
  name: string;
  joined: boolean;
  /** Highest seq ever accepted — monotonicity gate (spec §6.4). */
  highestSeq: number;
  /** Seq the timeline is processed through — echoed as reconciliation ack. */
  ackSeq: number;
  /** Inputs waiting for their mapped tick, strictly ascending seqs. */
  pendingInputs: InputItem[];
  /**
   * serverTick − clientSeq of this connection's input timeline; null until
   * the first input frame anchors it. Seq `s` is applied at server tick
   * `s + tickOffset`.
   */
  tickOffset: number | null;
  /**
   * Rewind depth (ticket 07): how many ticks this pilot's rendered view of
   * opponents trails the tick their inputs apply at. Derived from the
   * client-reported view tick and bounded by `rewindDepth` below.
   */
  viewDelayTicks: number;
  /** Last delay handed to the sim — views coalesce like turns, send on change. */
  sentViewDelay: number;
  /** Smoothed arrival margin in ticks (see LIMITS.tickMapMarginEmaWeight). */
  marginEma: number;
  /** Consecutive frames implying a broken timeline (resync hysteresis). */
  resyncStreak: number;
  /** Consecutive malformed frames; a valid frame resets it. */
  garbage: number;
  /** Ticks since the last valid frame — dead-socket detection. */
  idleTicks: number;
  /** Last leaderboard frame sent — resent only when it actually differs. */
  lastLeaderboard: Uint8Array | null;
}

/** Byte equality — the leaderboard's "did anything change?" test. */
function sameFrame(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export class ArenaCore {
  private readonly state: SimState;
  private readonly connections = new Map<number, Connection>();
  private pendingJoins: number[] = [];
  private pendingLeaves: number[] = [];
  /**
   * Live bot pilots by player id (ticket 12), in the order they were added —
   * retirement takes the newest, which has the least invested. Entries appear
   * the tick a bot is queued, so a bot is never spawned twice.
   */
  private readonly bots = new Map<number, BotPilot>();
  private pendingBotJoins: number[] = [];

  /**
   * `arenaSizeWU` overrides the BALANCE default (dev/testing, private rooms).
   *
   * `botTarget` is the population bots keep the arena at (spec §2.7). It is
   * **off unless asked for**, like the arena size and seed the DO shell decides:
   * the public arena passes `BALANCE.bots.targetPopulation`
   * (`arena-do.ts`), private rooms default to bots off per spec §10.4, and the
   * unit/scenario tests get an arena holding nobody they did not put there.
   */
  constructor(
    seed: number,
    arenaSizeWU?: number,
    private readonly botTarget = 0,
  ) {
    this.state = createSimState(seed, arenaSizeWU);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Register a fresh socket; the returned id is bound to it (spec §8.2).
   * Returns null when the arena is full (spec §8.3: clean rejection, no
   * queue) — also the guard that keeps the u8 snapshot player count and the
   * u16 wire ids safely in range.
   */
  connect(socket: ArenaSocket): number | null {
    if (this.connections.size >= LIMITS.maxConnections) return null;
    const id = this.allocatePlayerId();
    this.connections.set(id, {
      socket,
      name: '',
      joined: false,
      highestSeq: 0,
      ackSeq: 0,
      pendingInputs: [],
      tickOffset: null,
      viewDelayTicks: 0,
      sentViewDelay: 0,
      marginEma: MARGIN_EMA_START,
      resyncStreak: 0,
      garbage: 0,
      idleTicks: 0,
      lastLeaderboard: null,
    });
    return id;
  }

  /**
   * Smallest free id — ids are recycled because the wire carries them as
   * u16; a monotonic counter would silently truncate (and collide) after
   * 65k connects on a long-lived arena.
   */
  private allocatePlayerId(): number {
    for (let id = 1; ; id++) {
      if (
        !this.connections.has(id) &&
        !this.bots.has(id) &&
        !this.state.players.some((p) => p.id === id) &&
        !this.pendingLeaves.includes(id)
      ) {
        return id;
      }
    }
  }

  /** Socket gone — cancel an unspawned join, else queue the removal. */
  disconnect(playerId: number): void {
    if (this.connections.delete(playerId)) {
      const pendingJoin = this.pendingJoins.indexOf(playerId);
      if (pendingJoin !== -1) {
        // Joined and vanished within the same tick: the spawn has not
        // happened yet, and once the connection is gone nothing could ever
        // remove the player again — an immortal ghost. Cancel the spawn.
        this.pendingJoins.splice(pendingJoin, 1);
        return;
      }
      this.pendingLeaves.push(playerId);
    }
  }

  /**
   * One raw client frame. Malformed → dropped; persistent garbage → socket
   * killed (spec §8.3). Valid intents join the player's queue, keyed to
   * their mapped tick.
   */
  handleFrame(playerId: number, frame: Uint8Array): void {
    const connection = this.connections.get(playerId);
    if (!connection) return;
    const message = decodeClientMessage(frame);
    if (!message) {
      connection.garbage += 1;
      if (connection.garbage >= LIMITS.garbageKillThreshold) {
        connection.socket.close(1008, 'persistent garbage');
        this.disconnect(playerId);
      }
      return;
    }
    connection.garbage = 0;
    connection.idleTicks = 0;
    if (message.type === 'join') {
      if (!connection.joined) {
        connection.joined = true;
        connection.name = displayName(message.name, playerId);
        connection.socket.send(encodeWelcome(playerId, this.state.arenaSizeWU));
        // World sync for the joiner (ticket 04): every existing territory
        // and every active trail, full — from here on, territory changes
        // arrive as per-player deltas and trails derive from the snapshots.
        for (const p of this.state.players) {
          connection.socket.send(encodeTerritory(p.id, 'sync', p.territory));
          if (p.trail.length > 0) connection.socket.send(encodeTrail(p.id, p.trail));
        }
        this.pendingJoins.push(playerId);
      }
      return;
    }
    if (!connection.joined) return;
    const fresh: InputItem[] = [];
    for (const input of message.inputs) {
      if (input.seq <= connection.highestSeq) continue; // stale/replayed (spec §6.4)
      connection.highestSeq = input.seq;
      fresh.push(input); // strictly ascending, thanks to the gate above
    }
    const newest = fresh[fresh.length - 1];
    if (!newest) return;
    // Track BEFORE filtering, so the very frame that re-anchors a broken
    // timeline already steers again.
    this.trackTickOffset(connection, newest.seq);
    const tickOffset = connection.tickOffset;
    if (tickOffset === null) return; // unreachable — tracking always anchors
    connection.viewDelayTicks = this.rewindDepth(message.viewTick, newest.seq, tickOffset);
    for (const input of fresh) {
      // Mapped tick already simulated (turn persisted + acked): applying it
      // now would double-move the past. Late turn changes surface as one
      // small reconciliation glide on the client instead.
      if (input.seq + tickOffset <= this.state.tick) continue;
      connection.pendingInputs.push(input);
    }
    const overflow = connection.pendingInputs.length - LIMITS.maxPendingInputs;
    if (overflow > 0) connection.pendingInputs.splice(0, overflow);
  }

  /**
   * How far back this frame's intents get judged (ticket 07 rewind): the
   * newest intent applies at tick `seq + tickOffset`, sampled while the
   * client rendered opponents at its reported view tick — the gap between
   * the two is the honest depth.
   *
   * The report is client-supplied, so it is bounded twice. `tickOffset`
   * MEASURES the upstream travel (the margin servo parks it just above the
   * real one), so twice it plus the interpolation allowance is as deep as a
   * connection with this timing could honestly see; on top sits the hard
   * window. That makes under-reporting self-penalizing rather than free: to
   * be granted a deeper rewind, a client must genuinely let its own seqs
   * arrive later, which delays its own steering by the same amount. Still
   * pure timing — nothing here can assert game state (spec §6.4/§8.2).
   *
   * A view tick of 0 means "nothing rendered yet" (a joining client) and
   * grants NO rewind — never the full window, and it cannot be used to
   * freeze an earlier, deeper depth in place either.
   */
  private rewindDepth(viewTick: number, newestSeq: number, tickOffset: number): number {
    if (viewTick <= 0) return 0;
    const measurable = 2 * Math.max(0, tickOffset) + LIMITS.rewindInterpAllowanceTicks;
    const reported = newestSeq + tickOffset - viewTick;
    return Math.min(LIMITS.rewindMaxTicks, measurable, Math.max(0, reported));
  }

  /**
   * Fold one input frame's newest seq into the connection's tick mapping.
   * Anchor on first contact; re-anchor after a sustained timeline break
   * (client stall/clock jump — its seqs would otherwise map into the acked
   * past forever, muting steering); otherwise servo the offset by ±1 around
   * a small standing arrival margin (every idle tick of margin is 50 ms of
   * input latency, every missing one costs late-dropped inputs).
   */
  private trackTickOffset(connection: Connection, newestSeq: number): void {
    // Offset that would map this seq to the very next tick (zero margin).
    const implied = this.state.tick + 1 - newestSeq;
    if (connection.tickOffset === null) {
      connection.tickOffset = implied;
      connection.marginEma = MARGIN_EMA_START;
      return;
    }
    if (Math.abs(implied - connection.tickOffset) > LIMITS.tickMapResyncTicks) {
      connection.resyncStreak += 1;
      if (connection.resyncStreak >= LIMITS.tickMapResyncFrames) {
        connection.tickOffset = implied;
        connection.marginEma = MARGIN_EMA_START;
        connection.resyncStreak = 0;
      }
      return;
    }
    connection.resyncStreak = 0;
    const margin = connection.tickOffset - implied;
    connection.marginEma += LIMITS.tickMapMarginEmaWeight * (margin - connection.marginEma);
    if (connection.marginEma < LIMITS.tickMapMinMarginTicks) {
      connection.tickOffset += 1;
      connection.marginEma += 1;
    } else if (connection.marginEma > LIMITS.tickMapMaxMarginTicks) {
      connection.tickOffset -= 1;
      connection.marginEma -= 1;
    }
  }

  /** Joined connections — the humans the population rule counts (spec §2.7). */
  private humanCount(): number {
    let humans = 0;
    for (const connection of this.connections.values()) {
      if (connection.joined) humans += 1;
    }
    return humans;
  }

  /**
   * Keep the arena populated (spec §2.7, ADR-0005):
   * `bots = clamp(target − humans, 0, maxBots)`, and 0 humans → 0 bots so an
   * empty arena drains and the DO can hibernate at zero cost.
   *
   * Humans always come first — bots are counted against the target, never
   * against `LIMITS.maxConnections`, so a bot can neither occupy a connection
   * slot nor stand between a human and one. A human who joins this tick already
   * counts here, so a bot retires the moment they arrive rather than a tick
   * later.
   */
  private manageBots(): void {
    const humans = this.humanCount();
    // The spec's formula verbatim — the lower bound matters: with MORE humans
    // than the target, `target − humans` is negative.
    //
    // The target is honoured as given. Whoever DECIDES it applies the arena's
    // area sizing (`defaultBotTarget` in router.ts) — the DO shell for the
    // public arena, the host for a private room (spec §10.4 lets them set a bot
    // count, so this must never quietly override one).
    const wanted =
      humans === 0 ? 0 : Math.max(0, Math.min(BALANCE.bots.maxBots, this.botTarget - humans));
    while (this.bots.size < wanted) {
      const id = this.allocatePlayerId();
      this.bots.set(id, new BotPilot(id));
      this.pendingBotJoins.push(id);
    }
    // Newest first: it has the least invested (and, mid-join, nothing at all).
    for (const id of [...this.bots.keys()].reverse().slice(0, this.bots.size - wanted)) {
      this.bots.delete(id);
      const queued = this.pendingBotJoins.indexOf(id);
      // Queued but never spawned: drop the join instead of asking the sim to
      // remove a player it has not created (which would leak the id).
      if (queued !== -1) this.pendingBotJoins.splice(queued, 1);
      else this.pendingLeaves.push(id);
    }
  }

  /**
   * Each bot's intent for this tick, through the very seam a decoded client
   * frame ends up in (ADR-0005: same input interface, source = local heuristic
   * instead of a WebSocket). A bot queued this tick has no body yet — it spawns
   * with the step below and steers from the next tick on.
   */
  private steerBots(turns: { id: number; turn: TurnSignal }[]): void {
    for (const [id, pilot] of this.bots) {
      const sight = senseFor(this.state, id);
      if (sight) turns.push({ id, turn: pilot.steer(sight) });
    }
  }

  /** One authoritative 20 Hz tick: apply each tick-mapped intent, snapshot all. */
  tick(dtSec: number): void {
    const turns: { id: number; turn: TurnSignal }[] = [];
    const views: { id: number; viewDelayTicks: number }[] = [];
    for (const [id, connection] of this.connections) {
      // Dead-socket sweep: transports don't always deliver a close event
      // (half-open TCP after an abrupt browser kill) — without this, ghost
      // players circle the arena forever.
      connection.idleTicks += 1;
      if (connection.idleTicks > LIMITS.idleTimeoutTicks) {
        connection.socket.close(1001, 'idle timeout');
        this.disconnect(id);
        continue;
      }
      if (connection.tickOffset === null) continue;
      // Rewind depth changed → tell the sim once; it persists like a turn.
      if (connection.viewDelayTicks !== connection.sentViewDelay) {
        views.push({ id, viewDelayTicks: connection.viewDelayTicks });
        connection.sentViewDelay = connection.viewDelayTicks;
      }
      const expectedSeq = this.state.tick + 1 - connection.tickOffset;
      const queue = connection.pendingInputs;
      // Entries below the expected seq were superseded by a resync/tighten
      // step — their ticks already ran.
      while (queue.length > 0 && (queue[0]?.seq ?? Infinity) < expectedSeq) queue.shift();
      const head = queue[0];
      if (head?.seq === expectedSeq) {
        queue.shift();
        turns.push({ id, turn: head.turn });
      }
      // else: input still in flight — the sim persists the current turn and
      // the ack below moves past this tick regardless ("processed").
    }
    // Population last, so a human who joined this tick is already counted and
    // the bots steer against the same pre-step state everyone else does.
    this.manageBots();
    this.steerBots(turns);

    // Bot spawns need the same territory sync as human ones — a start block
    // nobody was told about would be invisible land until its first fill.
    const spawned = [...this.pendingJoins, ...this.pendingBotJoins];
    const events = step(
      this.state,
      {
        joins: this.pendingJoins,
        botJoins: this.pendingBotJoins,
        leaves: this.pendingLeaves,
        turns,
        views,
      },
      dtSec,
    );
    this.pendingJoins = [];
    this.pendingBotJoins = [];
    this.pendingLeaves = [];

    // Event frames of this tick, sent BEFORE its snapshot. Deaths first
    // (ticket 05): a client clears the victim's trail on the death frame,
    // then the respawn arrives — territory syncs (deaths + spawns + steal
    // survivors, ticket 06), fill deltas (ticket 04, spec §6.1: the only
    // source of territory truth) — so everything is known when the tick's
    // poses land. Steal syncs precede the fill: the loser shrinks before
    // the winner covers the same ground.
    const eventFrames: Uint8Array[] = [];
    for (const death of events.deaths) {
      eventFrames.push(encodeDeath(death.victimId, death.killerId, death.cause));
    }
    // A Set keeps the order and drops duplicates (a same-tick spawn that
    // immediately lost land would otherwise sync twice).
    const syncIds = new Set([
      ...events.deaths.map((d) => d.victimId),
      ...spawned,
      ...events.steals,
    ]);
    for (const id of syncIds) {
      const p = this.state.players.find((q) => q.id === id);
      if (p) eventFrames.push(encodeTerritory(id, 'sync', p.territory));
    }
    for (const id of events.fills) {
      const p = this.state.players.find((q) => q.id === id);
      if (p) eventFrames.push(encodeTerritory(id, 'fill', p.territory));
    }
    if (eventFrames.length > 0) {
      for (const connection of this.connections.values()) {
        if (!connection.joined) continue;
        for (const frame of eventFrames) connection.socket.send(frame);
      }
    }

    // Each closed life's counters go to exactly the pilot whose life it was
    // (ticket 09): the score is personal, never broadcast. Sent after this
    // tick's death frame, so the client resets its running estimate first and
    // then commits the final one to its local records.
    for (const stats of events.endedLives) {
      const connection = this.connections.get(stats.playerId);
      if (connection?.joined) connection.socket.send(encodeScore(stats, true));
    }

    const players: SnapshotPlayer[] = this.state.players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      heading: p.heading,
      turn: p.turn,
    }));
    for (const connection of this.connections.values()) {
      // World state only flows to sockets that actually joined (spec §8.2) —
      // an upgrade without a join gets nothing but the idle timeout.
      if (!connection.joined) continue;
      // The ack is derived, never counted: processed through = current tick
      // on this connection's input timeline. It rebases (backwards, once)
      // when a resync re-anchors the timeline.
      if (connection.tickOffset !== null) {
        connection.ackSeq = this.state.tick - connection.tickOffset;
      }
      connection.socket.send(encodeSnapshot(this.state.tick, connection.ackSeq, players));
    }

    this.broadcastLeaderboard();
    this.sendOwnScores();
  }

  /**
   * The running life's score ingredients (ticket 09, spec §2.5), to each
   * pilot's own socket every `scoreIntervalTicks`. Not deduped like the
   * leaderboard: the survival term inside moves every tick, so every frame
   * differs by construction — ten bytes twice a second is the whole cost, and
   * it keeps the HUD number ANCHORED instead of accumulated forever from one
   * early frame.
   */
  private sendOwnScores(): void {
    if (this.state.tick % LIMITS.scoreIntervalTicks !== 0) return;
    for (const [id, connection] of this.connections) {
      if (!connection.joined) continue;
      const player = this.state.players.find((p) => p.id === id);
      // Joined but not yet spawned (the join's tick has not run): no life yet.
      if (player) connection.socket.send(encodeScore(lifeStats(player), false));
    }
  }

  /**
   * The global ranking (spec §2.5, ticket 08): every `leaderboardIntervalTicks`
   * the table is derived from the live territories — no persistence, nothing
   * accumulated (ADR-0004) — and each client gets the top rows plus, appended,
   * its own row when it ranks below them.
   *
   * Sent only when the recipient's frame actually differs from the last one.
   * Comparing the ENCODED frames dedupes at exactly the resolution the client
   * can see (percent to two decimals): shares only move when land does, so a
   * quiet arena costs one derivation every half second and zero bytes.
   */
  private broadcastLeaderboard(): void {
    if (this.state.tick % LIMITS.leaderboardIntervalTicks !== 0) return;
    const table = standings(this.state);
    const row = (standing: Standing): LeaderboardRow => ({
      rank: standing.rank,
      playerId: standing.playerId,
      areaPct: standing.areaPct,
      // Sim entities without a connection are bots (ticket 12) — they rank
      // like anyone else, they just have no join name to show.
      name: this.connections.get(standing.playerId)?.name ?? guestName(standing.playerId),
    });
    const topRows = table.slice(0, BALANCE.leaderboard.topN).map(row);
    for (const [id, connection] of this.connections) {
      if (!connection.joined) continue;
      const own = table.find((standing) => standing.playerId === id);
      const rows = own && own.rank > BALANCE.leaderboard.topN ? [...topRows, row(own)] : topRows;
      const frame = encodeLeaderboard(rows);
      if (connection.lastLeaderboard && sameFrame(connection.lastLeaderboard, frame)) continue;
      connection.lastLeaderboard = frame;
      connection.socket.send(frame);
    }
  }
}
