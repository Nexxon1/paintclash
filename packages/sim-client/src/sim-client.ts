/**
 * `sim-client` — headless client (CONTEXT: Sim-Client): drives `sim-core` and
 * speaks the real binary protocol, but never renders. Transport-agnostic —
 * the constructor takes a raw `send(frame)`; scenario tests plug a real
 * WebSocket in, unit tests a capture array (spec §9.1).
 */

import {
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  MAX_INPUT_BATCH,
  type InputItem,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import type { TurnSignal } from '@paintclash/shared';
import { advancePlayer, type PlayerSim } from '@paintclash/sim-core';

export interface Snapshot {
  tick: number;
  ackSeq: number;
  players: SnapshotPlayer[];
}

export class SimClient {
  /** Own id once the welcome arrived. */
  playerId: number | null = null;
  arenaSizeWU: number | null = null;
  /** Latest authoritative snapshot (stale ones are dropped). */
  snapshot: Snapshot | null = null;
  /**
   * Test hook: called for EVERY fresh snapshot. `snapshot` only keeps the
   * latest, but per-tick assertions (input timing) must not miss one.
   */
  onSnapshot: ((snapshot: Snapshot) => void) | null = null;

  private readonly send: (frame: Uint8Array) => void;
  private readonly name: string;
  // Seqs start at 1 — the server's ack starts at 0 meaning "nothing yet".
  private nextSeq = 1;
  private queued: InputItem[] = [];
  private predicted: PlayerSim | null = null;

  constructor(send: (frame: Uint8Array) => void, name = 'sim-client') {
    this.send = send;
    this.name = name;
  }

  /** Send the join wish. */
  join(): void {
    this.send(encodeJoin(this.name));
  }

  /** Feed a raw server frame in; malformed or stale frames are ignored. */
  receive(frame: Uint8Array | ArrayBuffer): void {
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    const message = decodeServerMessage(bytes);
    if (!message) return;
    if (message.type === 'welcome') {
      this.playerId = message.playerId;
      this.arenaSizeWU = message.arenaSizeWU;
      return;
    }
    if (this.snapshot && message.tick <= this.snapshot.tick) return;
    this.snapshot = { tick: message.tick, ackSeq: message.ackSeq, players: message.players };
    // Re-base prediction on every fresh authoritative state.
    const self = this.self();
    this.predicted = self ? { ...self } : null;
    this.onSnapshot?.(this.snapshot);
  }

  /** The own player in the latest snapshot, if joined and alive. */
  self(): SnapshotPlayer | null {
    if (this.playerId === null || !this.snapshot) return null;
    return this.snapshot.players.find((p) => p.id === this.playerId) ?? null;
  }

  /** Queue a steer intent for the next flush; seq numbers are monotonic. */
  queueTurn(turn: TurnSignal): void {
    this.queued.push({ seq: this.nextSeq++, turn });
    if (this.predicted) this.predicted.turn = turn;
  }

  /** Send everything queued, split into protocol-legal batches (§6.3). */
  flush(): void {
    while (this.queued.length > 0) {
      const batch = this.queued.splice(0, MAX_INPUT_BATCH);
      this.send(encodeInput(batch));
    }
  }

  /** Advance the local prediction one fixed step — the same sim-core math. */
  predictTick(dtSec: number): void {
    if (!this.predicted || this.arenaSizeWU === null) return;
    advancePlayer(this.predicted, this.arenaSizeWU, dtSec);
  }

  /** Where prediction currently places the own head. */
  predictedSelf(): PlayerSim | null {
    return this.predicted;
  }
}
