/**
 * Cross-package domain types (spec §5.1). Kept here so `sim-core`, `protocol`,
 * `server` and `client` all speak the exact same vocabulary.
 */

/** Steer intent: -1 = left, 0 = straight, 1 = right (CONTEXT: Steuer-Intent). */
export type TurnSignal = -1 | 0 | 1;

/**
 * Why a player died (spec §2.1) — spoken identically by `sim-core` (the
 * verdict), `protocol` (the wire cause byte) and the clients. `totalLoss` =
 * the whole territory was painted away (ticket 06): territory is the life
 * line, the head's own position grants no reprieve.
 */
export type DeathCause = 'trailCut' | 'headOn' | 'totalLoss';

/**
 * One life's score ingredients (spec §10.5, ticket 09) — the shape the sim
 * accumulates, the wire carries and the HUD scores. Defined here because
 * `protocol` must speak it without depending on `sim-core` (ADR-0002 keeps the
 * wire below the game logic).
 *
 * Time is in TICKS: the sim has no clock (ADR-0003), so seconds appear only
 * where the score is actually computed.
 */
export interface LifeCounters {
  /** Largest share of the map (percent) held during the life. */
  peakPct: number;
  /** Ticks the life has lasted. */
  lifeTicks: number;
  /** Time-averaged number of concurrently alive OTHER humans (bots excluded). */
  avgOtherHumans: number;
}

/**
 * Continuous-world geometry (spec §2.2: polygon-based fill). The shapes are
 * polyclip-ts-compatible so sim-core's boolean ops consume them verbatim;
 * `protocol` and `client` share them without depending on sim-core.
 */

/** One vertex in WU. */
export type Point = [number, number];

/** One simple polygon ring; implicitly closed (last vertex ≠ first). */
export type Ring = Point[];

/**
 * One connected territory piece: outer ring first, then hole rings (even-odd).
 * Since stealing (ticket 06) stored territories are hole-free in practice — a
 * loop captures everything it encloses, and losing land only ever bites from
 * the boundary inward. The hole shape stays: clipper output and the wire
 * speak it, and `validPolyTopology` guards it.
 */
export type Poly = Ring[];

/** A player's whole territory: disjoint pieces (CONTEXT: Gebiet). */
export type Territory = Poly[];
