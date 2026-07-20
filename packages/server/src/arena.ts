/**
 * ArenaCore — the authoritative arena brain, free of any Durable Object API
 * so every rule is unit-testable in plain node (spec §9.1). The DO shell
 * (`arena-do.ts`) owns transport + 20 Hz pacing and delegates everything else
 * here.
 *
 * Trust boundary (spec §8.2): clients speak *only* via `handleFrame`, which
 * decodes, validates and queues steer intents. Positions are re-derived from
 * `sim-core` every tick — nothing a client sends can express position,
 * speed, or another player's id.
 *
 * Input timeline: the client samples one intent per sim tick and ships them
 * batched (spec §6.3). The server queues fresh intents per player and applies
 * exactly ONE per tick, reconstructing the client's timeline — a short tap
 * inside a batch is never collapsed away. Backlog beyond
 * `LIMITS.maxPendingInputs` is flood; the oldest entries drop (spec §8.3).
 */

import {
  decodeClientMessage,
  encodeSnapshot,
  encodeWelcome,
  type InputItem,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import { LIMITS, type TurnSignal } from '@paintclash/shared';
import { advancePlayer, createSimState, step, type SimState } from '@paintclash/sim-core';

/** What ArenaCore needs from a transport — a DO WebSocket satisfies this. */
export interface ArenaSocket {
  send(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface Connection {
  socket: ArenaSocket;
  /** Display name from the join (stored for later tickets; not broadcast). */
  name: string;
  joined: boolean;
  /** Highest seq ever accepted — monotonicity gate (spec §6.4). */
  highestSeq: number;
  /** Seq of the last *applied* intent — echoed as reconciliation ack. */
  ackSeq: number;
  /** Fresh intents waiting to be applied, one per tick, oldest first. */
  pendingInputs: InputItem[];
  /** Jitter buffer: while true, queued intents are held, not consumed. */
  buffering: boolean;
  /** Ticks the oldest queued intent has waited while buffering. */
  bufferWait: number;
  /** Consecutive malformed frames; a valid frame resets it. */
  garbage: number;
  /** Ticks since the last valid frame — dead-socket detection. */
  idleTicks: number;
}

export class ArenaCore {
  private readonly state: SimState;
  private readonly connections = new Map<number, Connection>();
  private pendingJoins: number[] = [];
  private pendingLeaves: number[] = [];

  constructor(seed: number) {
    this.state = createSimState(seed);
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
      buffering: true,
      bufferWait: 0,
      garbage: 0,
      idleTicks: 0,
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
   * killed (spec §8.3). Valid intents join the player's queue.
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
        connection.name = message.name;
        connection.socket.send(encodeWelcome(playerId, this.state.arenaSizeWU));
        this.pendingJoins.push(playerId);
      }
      return;
    }
    if (!connection.joined) return;
    for (const input of message.inputs) {
      if (input.seq <= connection.highestSeq) continue; // stale/replayed (spec §6.4)
      connection.highestSeq = input.seq;
      connection.pendingInputs.push(input);
    }
    const overflow = connection.pendingInputs.length - LIMITS.maxPendingInputs;
    if (overflow > 0) connection.pendingInputs.splice(0, overflow);
  }

  /** One authoritative 20 Hz tick: apply one intent per player, snapshot all. */
  tick(dtSec: number): void {
    const turns: { id: number; turn: TurnSignal }[] = [];
    const catchUps: { connection: Connection; id: number; input: InputItem }[] = [];
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
      const queue = connection.pendingInputs;
      // Jitter buffer: hold until a batch is in (or the lone intent waited
      // long enough), so a slightly late batch never dries the queue out.
      if (connection.buffering && queue.length > 0) {
        connection.bufferWait += 1;
        if (
          queue.length >= LIMITS.inputBufferTicks ||
          connection.bufferWait >= LIMITS.inputBufferTicks
        ) {
          connection.buffering = false;
        }
      }
      if (connection.buffering) continue;
      const input = queue.shift();
      if (input) {
        connection.ackSeq = input.seq;
        turns.push({ id, turn: input.turn });
        // Catch-up drain: after a client-side stall the client fast-forwards
        // several ticks at once and its inputs arrive as a burst. Consume a
        // second intent this tick (as one extra sim advance below) so the
        // backlog shrinks instead of being dropped — a dropped turn would
        // permanently bend the head's path away from what the player saw.
        if (queue.length > LIMITS.inputBacklogTarget) {
          const extra = queue.shift();
          if (extra) catchUps.push({ connection, id, input: extra });
        }
      } else {
        connection.buffering = true;
        connection.bufferWait = 0;
      }
    }
    step(this.state, { joins: this.pendingJoins, leaves: this.pendingLeaves, turns }, dtSec);
    for (const { connection, id, input } of catchUps) {
      const player = this.state.players.find((p) => p.id === id);
      if (!player) continue;
      player.turn = input.turn;
      advancePlayer(player, this.state.arenaSizeWU, dtSec);
      connection.ackSeq = input.seq;
    }
    this.pendingJoins = [];
    this.pendingLeaves = [];

    const players: SnapshotPlayer[] = this.state.players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      heading: p.heading,
      turn: p.turn,
      blockCx: p.blockCx,
      blockCy: p.blockCy,
    }));
    for (const connection of this.connections.values()) {
      // World state only flows to sockets that actually joined (spec §8.2) —
      // an upgrade without a join gets nothing but the idle timeout.
      if (!connection.joined) continue;
      connection.socket.send(encodeSnapshot(this.state.tick, connection.ackSeq, players));
    }
  }
}
