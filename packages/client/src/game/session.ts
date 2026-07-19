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

/**
 * Enemies render this many ticks behind estimated server time (spec §6.1).
 * 3 ticks = 150 ms: enough headroom that clock-estimate noise never pushes
 * the sample past the newest snapshot (which would stall-and-jump); well
 * inside the genre's latency tolerance (spec §6.3: ~500 ms).
 */
const INTERP_DELAY_TICKS = 3;

/**
 * EMA weight for the server-clock offset. The enemy timeline must advance on
 * the *local* tick clock — pinning it to snapshot arrival times would turn
 * every bit of network jitter into a visible time jump. Samples are
 * quantized to whole ticks, so the weight stays small.
 */
const OFFSET_SMOOTHING = 0.05;

/** An offset this many ticks off is a real clock break — resync hard. */
const OFFSET_RESYNC_TICKS = 10;

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

  /** One fixed 20 Hz tick: sample input, predict, batch, maybe flush. */
  simTick(turn: TurnSignal): void {
    if (!this.predictor || !this.ready()) return;
    this.clientTicks += 1;
    const seq = this.nextSeq++;
    this.queued.push({ seq, turn });
    this.predictor.applyLocalInput(seq, turn, TICK_DT_SEC);
    this.predictor.decayError();
    this.ticksSinceFlush += 1;
    // Flush on the batch cadence — or immediately when the steer direction
    // changes: turn onsets are what latency is felt on, and they are rare
    // enough to stay well inside the 20:1 message budget (spec §6.3).
    if (this.ticksSinceFlush >= INPUT_FLUSH_TICKS || turn !== this.lastSentTurn) this.flush();
    this.lastSentTurn = turn;
  }

  /** Everything the renderer needs, at inter-tick blend factor `alpha`. */
  renderSample(alpha: number): RenderState {
    // Enemy timeline = smooth local clock + smoothed offset − delay. It
    // advances every local tick even when a snapshot arrives late.
    const others =
      this.serverOffset === null
        ? []
        : this.interpolator.sample(
            this.clientTicks + alpha + this.serverOffset - INTERP_DELAY_TICKS,
            this.playerId ?? undefined,
          );
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
