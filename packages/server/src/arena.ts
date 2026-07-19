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
import { LIMITS } from '@paintclash/shared';
import { createSimState, step, type SimState } from '@paintclash/sim-core';

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
  /** Consecutive malformed frames; a valid frame resets it. */
  garbage: number;
}

export class ArenaCore {
  private readonly state: SimState;
  private readonly connections = new Map<number, Connection>();
  private nextPlayerId = 1;
  private pendingJoins: number[] = [];
  private pendingLeaves: number[] = [];

  constructor(seed: number) {
    this.state = createSimState(seed);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Register a fresh socket; the returned id is bound to it (spec §8.2). */
  connect(socket: ArenaSocket): number {
    const id = this.nextPlayerId++;
    this.connections.set(id, {
      socket,
      name: '',
      joined: false,
      highestSeq: 0,
      ackSeq: 0,
      pendingInputs: [],
      garbage: 0,
    });
    return id;
  }

  /** Socket gone — queue the player's removal for the next tick. */
  disconnect(playerId: number): void {
    if (this.connections.delete(playerId)) {
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
    const turns: { id: number; turn: InputItem['turn'] }[] = [];
    for (const [id, connection] of this.connections) {
      const input = connection.pendingInputs.shift();
      if (input) {
        connection.ackSeq = input.seq;
        turns.push({ id, turn: input.turn });
      }
    }
    step(this.state, { joins: this.pendingJoins, leaves: this.pendingLeaves, turns }, dtSec);
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
      connection.socket.send(encodeSnapshot(this.state.tick, connection.ackSeq, players));
    }
  }
}
