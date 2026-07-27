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
     * Head/collision radius (half the trail width): a head within this of a
     * trail centerline cuts it; heads within twice this collide head-on.
     */
    collisionRadiusWU: 0.5,
    /**
     * Path length behind the own head exempt from the self-cut test. The
     * trail ends glued to the head (distance 0), so some grace is mandatory;
     * its size is bounded by geometry on both sides:
     *
     * - Lower bound ≈ 4.2 WU: the soft barrier's clamp (spec §2.4) can slide
     *   a pinned head back over its own just-laid wall trail — turning away
     *   from the wall contacts trail up to ~4.2 WU of path behind the head.
     *   Killing that would be an edge death in disguise.
     * - Upper bound π·turn radius ≈ 5.06 WU: away from walls the turn-rate
     *   cap (radius r ≈ 1.61 WU) keeps the head ≥ 2r·sin(s/2r) from trail
     *   laid s ≤ πr ago, so NO genuine self-contact exists below πr of path —
     *   every real self-cross (tightest: the full circle, contact at
     *   ~2πr − 0.5 ≈ 9.6 WU) stays detectable.
     */
    selfCutGraceWU: 4.5,
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
  /** Leaderboard (spec §2.5) — the global live ranking's shape. */
  leaderboard: Object.freeze({
    /**
     * Rows every client sees. The own row is appended when it ranks below
     * them, so a client is shown at most `topN + 1` rows.
     */
    topN: 5,
    /**
     * Decimals the share is shown (and transmitted) with. Also the
     * resolution the RANKING is decided at: two players whose shares look
     * identical are ordered by id, not by float noise below the last shown
     * digit — otherwise equal-looking rows would swap places at random.
     * Two decimals: a 6×6 start block in the 200 WU arena is 0,09 %.
     */
    percentDecimals: 2,
  }),
});

/**
 * Integer resolution of a leaderboard share: `areaPct × this` is the number
 * the ranking compares, the wire carries and the HUD prints. One source, so
 * ranking, transport and display can never drift apart (spec §5.1/§2.5).
 */
export const LEADERBOARD_PERCENT_SCALE = 10 ** BALANCE.leaderboard.percentDecimals;

/** Simulation tickrate (spec §6.2): 20 Hz — the splix-proven sweet spot. */
export const TICK_HZ = 20;

/** Fixed simulation timestep in milliseconds (dt = 50 ms at 20 Hz). */
export const TICK_DT_MS = 1000 / TICK_HZ;

/** Fixed simulation timestep in seconds — what `sim-core` steps with. */
export const TICK_DT_SEC = 1 / TICK_HZ;
