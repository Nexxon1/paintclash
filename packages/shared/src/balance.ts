/**
 * Balance start values (spec §10) — the single source of truth, read
 * identically by `sim-core`, `server` and `client` (spec §10.6, ADR-0002).
 *
 * All values are reasoned *start* values, meant to be re-tuned against a
 * playable build. Tuning happens here at build time — never via runtime I/O,
 * which keeps `sim-core` pure and deterministic (ADR-0003).
 *
 * Groups grow with the build tickets: trail/bots/room/score land with their
 * features (tickets 04+). Ticket 03 needs arena / movement / spawn.
 */
export const BALANCE = Object.freeze({
  /** Public arena (spec §10.2). */
  arena: Object.freeze({
    /** Edge length of the square arena in world units. */
    sizeWU: 200,
  }),
  /** Movement (spec §10.3): constant speed, clamped turn rate. */
  movement: Object.freeze({
    /** Head speed — constant, never scales with territory size. */
    speedWuPerSec: 9,
    /** Maximum turn rate; server clamps every intent to this. */
    turnRateDegPerSec: 320,
  }),
  /** Spawn (spec §10.4). */
  spawn: Object.freeze({
    /** Edge length of the square start block a player spawns on. */
    startBlockWU: 6,
    /** Best-effort minimum distance to enemy heads/territory at spawn. */
    minDistanceWU: 25,
  }),
  /** Trail & fill (spec §10.4). */
  trail: Object.freeze({
    /** Rendered trail width — the continuous analog of splix' 1-tile trail. */
    widthWU: 1,
    /**
     * Fills gaining less than this are discarded (spec §2.2) — purely to
     * drop numerical slivers; every deliberate loop paints. Re-tuned from
     * the spec §10.4 start value of 1 WU² (ticket 04): shallow loops hugged
     * along the own edge deliberately enclose well under 1 WU² and must
     * fill — the spec's assumption that sub-1-WU² can't be deliberate only
     * holds for free-standing loops (turn radius 1.6 WU ⇒ ≥ ~8 WU²).
     */
    minFillAreaWU2: 0.01,
  }),
});

/** Simulation tickrate (spec §6.2): 20 Hz — the splix-proven sweet spot. */
export const TICK_HZ = 20;

/** Fixed simulation timestep in milliseconds (dt = 50 ms at 20 Hz). */
export const TICK_DT_MS = 1000 / TICK_HZ;

/** Fixed simulation timestep in seconds — what `sim-core` steps with. */
export const TICK_DT_SEC = 1 / TICK_HZ;
