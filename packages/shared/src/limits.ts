/**
 * Tunable protection/budget thresholds — kept beside `BALANCE` as spec §8.3
 * demands ("Schwellen als abstimmbare Konstanten, neben BALANCE"), calibrated
 * during implementation.
 */
export const LIMITS = Object.freeze({
  /**
   * **Arena-Populationsgrenze** (spec §8.3 point 4, ticket 15): concurrent
   * connections one arena admits before it refuses cleanly. 16 is the start
   * value the DO-CPU benchmark recommends (`docs/benchmarks/do-cpu-benchmark.md`,
   * ticket 02) — gameplay-motivated rather than CPU-motivated: the 200 WU arena
   * is dimensioned for ~15 entities (spec §10.2), so past that the map is the
   * scarce resource, not the tick. It is also the anti-dominance backstop
   * (§8.3: no queue, no auto-sharding at the limit).
   *
   * Counted per CONNECTION, not per joined player: a socket that upgraded but
   * has not announced itself is refused a slot for at most `joinDeadlineTicks`
   * (see below), which is what keeps the cap from being squattable.
   */
  maxPlayers: 16,
  /**
   * The CPU/wire ceiling `maxPlayers` may never be raised past. 64 is where the
   * benchmark's 25 ms criterion still holds with the local 4× hardware factor
   * in every measured variant; the wire adds a hard reason of its own — the
   * snapshot format counts players in a single byte, and an overflow would make
   * every snapshot undecodable for every client (global freeze). Also sizes the
   * client's color palette, so ids stay distinguishable up to here: the palette
   * spends its hues on the ids that can be live AT ONCE (`maxPlayers` + bots)
   * and covers the rest — reachable while departing ids are still blocked — on
   * a second axis, sized by this ceiling (`colors.ts PALETTE_TIERS`). That is a
   * practical cover, not a bound: this caps concurrent CONNECTIONS, not the ids
   * they draw, so it is the HUD discriminator that carries the far tail.
   */
  maxConnections: 64,
  /**
   * Ticks a connection may hold an arena slot without announcing itself
   * (ticket 15). The browser client sends its join the instant the socket
   * opens, so 60 ticks = 3 s is ~4× a bad round trip — generous for a player,
   * useless as an occupation: without it, one address could park
   * `maxConnectionsPerIp` silent sockets in the arena and re-park them forever,
   * which would make the population limit a denial-of-service tool.
   */
  joinDeadlineTicks: 60,
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
  /**
   * Ticks between two leaderboard broadcasts (ticket 08, spec §2.5). Shares
   * only change when land does (fill, steal, death, join/leave), so the
   * server sends on change — this is the pacing floor that keeps a busy
   * arena from turning every fill into a per-client frame. 10 ticks = 500 ms,
   * comfortably "live" for a number that moves in visible jumps.
   */
  leaderboardIntervalTicks: 10,
  /**
   * Ticks between two own-score frames (ticket 09, spec §2.5). Unlike the
   * leaderboard these cannot be deduped — the survival time inside them
   * moves every tick — so this interval IS the traffic: 10 ticks = 500 ms,
   * ten bytes twice a second per player. The HUD number itself stays smooth
   * regardless: the client advances the survival term on its own tick clock
   * between frames and only re-anchors on arrival.
   */
  scoreIntervalTicks: 10,
  /**
   * Deepest rewind (ticket 07, ADR-0003): the server judges an actor's
   * cuts/head-ons against opponents at the tick the actor was rendering,
   * at most this many ticks back (500 ms — the genre's latency tolerance,
   * spec §6.3). The hard ceiling on the client-reported view tick,
   * Source-style `sv_maxunlag`.
   */
  rewindMaxTicks: 10,
  /**
   * Interpolation headroom the server grants a reported view tick beyond the
   * round trip it can MEASURE (ticket 07). An honest view delay is upstream
   * travel + downstream travel + the client's own enemy-interpolation
   * buffer; only the travel is measurable server-side (from `tickOffset`),
   * so this covers the buffer: the client's base 1.5 ticks plus a couple of
   * ticks of its adaptive growth on bursty links. A client whose buffer has
   * grown past this rewinds slightly shallower than it renders — the same
   * trade real engines make — while a client on a fast link can no longer
   * claim a deep window it has no latency for.
   */
  rewindInterpAllowanceTicks: 4,
  /**
   * Private rooms one IP may create per `roomCreateWindowMs` (spec §8.3 point
   * 6: "Raum-Erstellung pro IP raten-begrenzt", ticket 14). Every room is a
   * fresh Durable Object plus a SQLite write, so this is the one room operation
   * that costs something before anyone has played a tick — and it is also the
   * brake on brute-forcing the code space by creating rather than guessing.
   *
   * Generous on purpose, like every per-IP cap in §8.3 ("im Zweifel
   * durchlassen"): five rooms a minute is far past what a group of friends
   * behind one CGNAT address ever needs, while a script gets a hard ceiling of
   * 300 DOs an hour per address instead of thousands.
   */
  roomCreatePerIp: 5,
  roomCreateWindowMs: 60_000,
  /**
   * Concurrent sockets one address may hold in ONE arena (spec §8.3 point 3,
   * ticket 15). Deliberately as generous as the arena itself: a shared WLAN or a
   * CGNAT address is one address to us, and §8.3's rule for every per-IP cap is
   * "im Zweifel durchlassen" — refusing the ninth person in a LAN party would be
   * the protection doing the damage. What it does buy is that a single address
   * cannot open sockets without bound: memory, per-socket state and the
   * disconnect bookkeeping all stay proportional to the arena's own limit.
   */
  maxConnectionsPerIp: 16,
  /**
   * Socket opens one address may make per `joinWindowMs` (spec §8.3 point 3:
   * "Join-Rate pro IP gegen Reconnect-Spam + Raum-Code-Brute-Force"). Charged
   * for every `/ws` upgrade, including one a room refuses — guessing codes is
   * exactly the traffic this counts.
   *
   * 120 a minute is 2/s sustained from one address: far past a player (one open
   * per game, a handful on a bad line), past a full CGNAT address reconnecting,
   * and past the local test suites, which all share one address. Against abuse
   * it is still a hard brake: a code guesser gets ~170k tries a day against
   * ~10⁹ codes (spec §8.3 point 6), and reconnect spam can no longer wake the
   * one public arena hundreds of times a second.
   */
  joinPerIp: 120,
  joinWindowMs: 60_000,
  /**
   * Client frames one socket may send per `frameWindowMs` before the surplus is
   * dropped **unparsed** (spec §8.3 point 2, ticket 15).
   *
   * Calibrated against what the PROTOCOL allows, not against what the browser
   * client happens to do. That client batches (`inputFlushTicks`) and sends ~6.7
   * frames/s, but one intent per tick is legitimate by construction — the input
   * timeline is tick-mapped, `seq` IS a tick — so a client sending 20 a second is
   * playing, not flooding, and the scenario clients do exactly that. 40 is
   * therefore ~2× the honest ceiling, with the lobby's occasional settings frame
   * and a post-stall flush inside it.
   */
  framesPerWindow: 40,
  frameWindowMs: 1_000,
  /**
   * Consecutive over-budget windows before the socket is closed (spec §8.3:
   * "Kill bei anhaltendem Flood, Trennung nach kleinem Toleranzfenster"). The
   * surplus is dropped from the first window on; this is only about how long a
   * client may keep it up before losing the socket. 3 windows ≈ 3 s: long enough
   * that no hiccup reaches it, short enough that a flood costs the arena
   * three seconds of dropped bytes rather than a tick of work.
   */
  floodKillWindows: 3,
});
