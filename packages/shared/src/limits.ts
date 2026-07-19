/**
 * Tunable protection/budget thresholds — kept beside `BALANCE` as spec §8.3
 * demands ("Schwellen als abstimmbare Konstanten, neben BALANCE"), calibrated
 * during implementation.
 */
export const LIMITS = Object.freeze({
  /** Consecutive malformed frames before a socket is killed (spec §8.3). */
  garbageKillThreshold: 10,
  /**
   * Sim ticks per batched input frame (spec §6.3: batching is mandatory —
   * incoming WS messages bill 20:1 on Free). 3 ticks ≈ 6.7 msgs/s per player.
   */
  inputFlushTicks: 3,
  /**
   * Upper bound on queued-but-unapplied steer intents per player (~1 s).
   * Real browser jank makes clients burst-send legitimately; those inputs
   * must NEVER be dropped (a dropped turn permanently bends the head's path
   * — the server never turned, the client did). Backlog above
   * `inputBacklogTarget` drains at two inputs per tick instead; only flood
   * beyond this hard cap drops (spec §8.3).
   */
  maxPendingInputs: 20,
  /**
   * Queue depth above which the server consumes two intents per tick to
   * catch up after a client-side stall. Mirrors the client's own burst
   * catch-up, so reconciliation stays exact. Must sit ABOVE the queue's
   * normal oscillation peak (≈ batch size + jitter buffer), otherwise the
   * drain itself causes the dry-outs it exists to prevent.
   */
  inputBacklogTarget: 6,
  /**
   * Ticks without a single valid frame before a connection counts as dead
   * (a connected client sends an input batch every few ticks, so only
   * half-open/vanished sockets ever reach this).
   */
  idleTimeoutTicks: 200,
  /**
   * Jitter buffer: ticks the server holds a player's first queued intent
   * before starting to consume, so a batch arriving slightly late never
   * drains the queue dry (a dry-out shifts the whole input timeline by one
   * tick and surfaces as a reconciliation jerk on the client).
   */
  inputBufferTicks: 2,
});
