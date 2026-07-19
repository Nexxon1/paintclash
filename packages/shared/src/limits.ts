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
   * Upper bound on queued-but-unapplied steer intents per player. The server
   * applies one intent per tick (mirroring the client's input timeline);
   * anything beyond this backlog is flood, and the oldest entries drop
   * (spec §8.3: one effective input per player per tick).
   */
  maxPendingInputs: 8,
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
