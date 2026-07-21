/**
 * Tunable protection/budget thresholds — kept beside `BALANCE` as spec §8.3
 * demands ("Schwellen als abstimmbare Konstanten, neben BALANCE"), calibrated
 * during implementation.
 */
export const LIMITS = Object.freeze({
  /**
   * Hard cap on concurrent connections per arena. Provisional CPU ceiling
   * from the DO benchmark (build ticket 02); ticket 15 sets the gameplay
   * population limit. MUST stay below 256 — the snapshot wire format counts
   * players in a single byte, and an overflow would make every snapshot
   * undecodable for every client (global freeze).
   */
  maxConnections: 64,
  /** Consecutive malformed frames before a socket is killed (spec §8.3). */
  garbageKillThreshold: 10,
  /**
   * Sim ticks per batched input frame (spec §6.3: batching is mandatory —
   * incoming WS messages bill 20:1 on Free). 3 ticks ≈ 6.7 msgs/s per player.
   */
  inputFlushTicks: 3,
  /**
   * Upper bound on queued-but-unapplied steer intents per player (~1 s of
   * future ticks). Inputs are tick-mapped (ticket 17): only seqs whose ticks
   * still lie ahead ever queue, so a standing backlog no longer exists — this
   * is purely the memory/flood cap for hostile or broken timelines (spec
   * §8.3); overflow drops the oldest entries.
   */
  maxPendingInputs: 20,
  /**
   * Ticks without a single valid frame before a connection counts as dead
   * (a connected client sends an input batch every few ticks, so only
   * half-open/vanished sockets ever reach this).
   */
  idleTimeoutTicks: 200,
  /**
   * Tick mapping (ticket 17): an input frame whose implied `tickOffset`
   * deviates from the tracked one by more than this is a timeline break
   * (client stall/clock jump), not network jitter.
   */
  tickMapResyncTicks: 10,
  /**
   * Consecutive out-of-range frames before the offset re-anchors — a single
   * delayed frame on an otherwise healthy line must not cause a resync.
   */
  tickMapResyncFrames: 2,
  /**
   * EMA weight of the smoothed arrival margin (frames arrive ~6.7/s on the
   * batch cadence → time constant ≈ 1.5 s).
   */
  tickMapMarginEmaWeight: 0.1,
  /**
   * Smoothed arrival margin (ticks of headroom before an input's mapped
   * tick) below which the mapping slackens by one tick: a dry margin means
   * jitter is eating inputs (each late turn change costs a visible glide).
   */
  tickMapMinMarginTicks: 0.15,
  /**
   * Smoothed arrival margin above which the mapping tightens by one tick:
   * standing headroom is pure added input latency. Band width vs the floor
   * is > 1 full tick, so the ±1 steps can never oscillate.
   */
  tickMapMaxMarginTicks: 1.35,
});
