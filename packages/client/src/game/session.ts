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
import { LIMITS, TICK_DT_SEC, type TurnSignal } from '@paintclash/shared';

import { Interpolator } from './interpolator.js';
import { Predictor, type RenderPose } from './predictor.js';

/** Sim ticks per batched input frame — the shared §6.3 batching cadence. */
export const INPUT_FLUSH_TICKS = LIMITS.inputFlushTicks;

/** Enemies render this many ticks behind the freshest snapshot (spec §6.1). */
const INTERP_DELAY_TICKS = 2;

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
    const self =
      this.playerId === null ? undefined : message.players.find((p) => p.id === this.playerId);
    if (self && this.predictor) {
      this.selfBlock = { cx: self.blockCx, cy: self.blockCy };
      this.predictor.reconcile(self, message.ackSeq, TICK_DT_SEC);
    }
  }

  /** One fixed 20 Hz tick: sample input, predict, batch, maybe flush. */
  simTick(turn: TurnSignal): void {
    if (!this.predictor || !this.ready()) return;
    const seq = this.nextSeq++;
    this.queued.push({ seq, turn });
    this.predictor.applyLocalInput(seq, turn, TICK_DT_SEC);
    this.predictor.decayError();
    this.ticksSinceFlush += 1;
    if (this.ticksSinceFlush >= INPUT_FLUSH_TICKS) this.flush();
  }

  /** Everything the renderer needs, at inter-tick blend factor `alpha`. */
  renderSample(alpha: number): RenderState {
    const latest = this.interpolator.latestTick();
    const others =
      latest === null
        ? []
        : this.interpolator.sample(latest - INTERP_DELAY_TICKS + alpha, this.playerId ?? undefined);
    return {
      self: this.predictor?.sample(alpha) ?? null,
      selfBlock: this.selfBlock,
      others,
      arenaSizeWU: this.arenaSizeWU,
    };
  }

  private flush(): void {
    this.ticksSinceFlush = 0;
    while (this.queued.length > 0) {
      this.send(encodeInput(this.queued.splice(0, MAX_INPUT_BATCH)));
    }
  }
}
