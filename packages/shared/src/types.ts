/**
 * Cross-package domain types (spec §5.1). Kept here so `sim-core`, `protocol`,
 * `server` and `client` all speak the exact same vocabulary.
 */

/** Steer intent: -1 = left, 0 = straight, 1 = right (CONTEXT: Steuer-Intent). */
export type TurnSignal = -1 | 0 | 1;

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
 * Holes are real gameplay: a loop around a *foreign* block captures the ring
 * around it but not the block itself (spec §2.2 — stealing lands in ticket 06).
 */
export type Poly = Ring[];

/** A player's whole territory: disjoint pieces (CONTEXT: Gebiet). */
export type Territory = Poly[];
