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
  /**
   * Bots (spec §2.7/§10.4, ADR-0005) — density *and* behaviour are balance,
   * not architecture: the pilot in `server/src/bot.ts` reads every number
   * below, so "competent but beatable" is tunable without touching its logic.
   *
   * The target is a gameplay choice, and affordable — but do not read the
   * benchmark's headline for it. Tickets 12 and 22 measured both halves against
   * real code (addenda in `docs/benchmarks/do-cpu-benchmark.md`): the bot pilots
   * themselves cost ≈ 0,017 ms/tick for all 8 together, i.e. nothing, while the
   * polygon fill is ≈ 99 % of everything else. Ticket 22 brought a saturating
   * 8-bot tick down to p95 12 ms / max 36–43 ms over 5 minutes (from max
   * 189 ms). That is inside the 50 ms budget LOCALLY; derated by the
   * benchmark's 4× hardware factor, p95 lands at the budget and the max is
   * roughly 3× over it — so this is not headroom, and the curve still climbs
   * with the map's vertex count. Raising the target is therefore a CPU
   * decision as well; ticket 16 measures it against the real build, ticket 23
   * holds the remaining growth.
   */
  bots: Object.freeze({
    /**
     * Entities (humans + bots) the public arena is kept populated to while at
     * least one human plays: `bots = clamp(target − humans, 0, maxBots)`.
     */
    targetPopulation: 8,
    /**
     * Ceiling on bots regardless of the target — the invariant that a bot can
     * never take a slot a human could have had (spec §2.7: humans first).
     */
    maxBots: 8,
    /**
     * Arena area one entity needs, in WU². The spec's own room-sizing rule read
     * backwards: §10.4 sizes a map as `edge = √(players × 5000)` (2p → 100 WU,
     * 8p → 200 WU, 16p → 280 WU), i.e. ~5000 WU² per player — and the public
     * arena's 200 WU gives exactly `targetPopulation` by that measure.
     *
     * It caps the population, because the target alone does not: eight bots in a
     * 50 WU dev arena (`pnpm dev:small`) is SIXTEEN times the density the spec
     * sizes for, and the fill cost grows with how interlocked territories are —
     * that arena saturated and blew the 50 ms tick budget within 30 s. A small
     * map now gets few bots or none, which is what the sizing rule always
     * implied. It bounds density, never the reverse: it can only ever lower the
     * count, so the 200 WU public arena is unaffected.
     */
    areaPerEntityWU2: 5000,
    /**
     * Perception radius in WU: a foreign HEAD farther away than this does not
     * exist for a bot (ADR-0005 — deliberately only "what a human could see").
     * Sized after the client camera, which sits `CAMERA_DISTANCE_WU` = 40 WU
     * from the head: a bot knows about as much of the arena as the player it
     * plays against.
     *
     * Heads are all a pilot senses, and that is not an omission: touching a
     * foreign trail kills its OWNER (spec §2.1), so a rival's line is an
     * opportunity rather than a danger. What can kill a bot is a head met
     * outside (`evadeRadiusWU`) and its own trail — which it avoids by the
     * SHAPE of its excursion, not by looking.
     */
    sightRadiusWU: 40,
    /**
     * Ticks between two decisions. Between them a bot keeps steering its
     * current plan — it cannot react to anything, which is the second half of
     * "beatable". 4 ticks = 200 ms, roughly human reaction time; well under the
     * genre's ~500 ms latency tolerance (spec §6.3), so a bot is not reacting
     * faster than the players it shares the arena with.
     */
    reactionTicks: 4,
    /** How far from home an excursion reaches before turning back, in WU. */
    excursionWU: 18,
    /**
     * Lateral offset of the return leg from the outbound one, in WU. Must
     * exceed twice the turn radius (2 × 1,61 = 3,22 WU) or the U-turn at the
     * tip would cross the outbound trail — a self-cut, i.e. suicide.
     */
    laneOffsetWU: 5,
    /**
     * Clearance kept from the arena edge when planning, in WU. The soft
     * barrier is survivable (spec §2.4) but a pinned head slides instead of
     * steering, which strands a bot mid-loop.
     */
    wallMarginWU: 10,
    /**
     * A foreign head this close (WU) aborts the excursion and sends the bot
     * home — the "ausweichen" half of the core loop. Well above the head-on
     * distance (2 × 0,5 WU), so evasion starts before contact is decided.
     */
    evadeRadiusWU: 12,
    /**
     * Trail path length (WU) after which a bot heads home regardless of its
     * plan. A safety net for runs that never reach their last waypoint (an
     * evade detour, a wall-pinned tick): every WU outside is exposure, and an
     * unclosed loop paints nothing.
     */
    maxTrailWU: 120,
  }),
  /**
   * Private rooms (spec §2.6/§10.4, ADR-0004) — the numbers a host picks
   * between, and what they get when they pick nothing. The *format* of a room
   * code is not here but in `room.ts` (`ROOM_CODE`), for the same reason the
   * nickname caps live with the nickname policy: it is a wire invariant, not a
   * knob to tune.
   */
  room: Object.freeze({
    /** Player limit range and default (spec §2.6: 2–16, default 8). */
    playerLimitMin: 2,
    playerLimitMax: 16,
    playerLimitDefault: 8,
    /**
     * Arena area one player is sized for, in WU² — the spec's own room-sizing
     * rule (§10.4: `Kante = √(Spieler × 5000)`). The very same number the
     * public arena's bot density is derived from
     * (`BALANCE.bots.areaPerEntityWU2`); one source, so the two ladders cannot
     * drift into disagreeing about how much room a player needs.
     */
    areaPerPlayerWU2: 5000,
    /**
     * Band a freely chosen map size is clamped into (spec §2.6: "frei
     * wählbar" — free, not unbounded).
     *
     * The floor is what the 16-player limit needs to mean anything: 16 start
     * blocks of 6 WU plus the spawn distance do not fit into much less, and
     * below it a room is a scrum rather than a game. The ceiling is 400 WU =
     * 160 000 WU², i.e. room for 32 players by the rule above — twice the
     * highest limit, so a host can build a deliberately empty field without
     * being able to ask for an arena nobody could cross.
     */
    mapSizeMinWU: 60,
    mapSizeMaxWU: 400,
    /**
     * Bot target a fresh room starts with. 0 = off, per spec §10.4 ("Bots
     * default aus") — a private room is for the people invited to it.
     */
    botTargetDefault: 0,
    /** Drop-in per link while the game runs, default on (spec §2.6). */
    lateJoinDefault: true,
    /**
     * Seconds an emptied room is held before it closes and its code is free
     * again (spec §2.6: "deckt kurze Disconnects"). Long enough for a browser
     * reload or a tunnel hiccup, short enough that abandoned codes do not pile
     * up in a key space this scheme sizes by obscurity.
     */
    graceSeconds: 90,
  }),
  /**
   * Score (spec §10.5) — the personal performance number
   * `round(peakPct × √survivalSec × (1 + humanBonus × ØotherHumans) × scale)`.
   * The sublinear time term is the formula's own shape, not a parameter.
   */
  score: Object.freeze({
    /**
     * Bonus per concurrently alive other HUMAN. Bots deliberately do not
     * count (spec §10.5) — otherwise a bot-stuffed private room would be
     * the cheapest way to farm the multiplier.
     */
    humanBonus: 0.25,
    /**
     * Overall scale. Purely presentational: it lifts the product into the
     * readable range the spec's reference runs quote (≈ 116 / 3 286 / 18 187).
     */
    scale: 10,
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
 * Integer resolution of a share of the map: `areaPct × this` is the number the
 * ranking compares, the wire carries and the HUD prints — for the leaderboard
 * row (spec §2.5) and for the score's peak share alike (spec §10.5). One
 * source, so ranking, score, transport and display can never drift apart
 * (spec §5.1). The digits themselves come from the leaderboard group: they are
 * what a player actually reads a share in.
 */
export const MAP_SHARE_PERCENT_SCALE = 10 ** BALANCE.leaderboard.percentDecimals;

/**
 * Tightest circle a head can fly, in WU (CONTEXT: **Wenderadius**) — speed over
 * turn rate in radians. Derived, never tuned: it falls out of the two movement
 * values above. One source because it is a real geometric bound that several
 * packages reason against (the bot pilot's lane offsets and waypoint tolerance,
 * the self-cut grace window's upper bound) — three hand-rolled copies of the
 * same conversion is how those arguments silently drift apart.
 */
export const TURN_RADIUS_WU =
  BALANCE.movement.speedWuPerSec / ((BALANCE.movement.turnRateDegPerSec * Math.PI) / 180);

/** Simulation tickrate (spec §6.2): 20 Hz — the splix-proven sweet spot. */
export const TICK_HZ = 20;

/** Fixed simulation timestep in milliseconds (dt = 50 ms at 20 Hz). */
export const TICK_DT_MS = 1000 / TICK_HZ;

/** Fixed simulation timestep in seconds — what `sim-core` steps with. */
export const TICK_DT_SEC = 1 / TICK_HZ;
