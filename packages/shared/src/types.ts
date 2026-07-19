/**
 * Cross-package domain types (spec §5.1). Kept here so `sim-core`, `protocol`,
 * `server` and `client` all speak the exact same vocabulary.
 */

/** Steer intent: -1 = left, 0 = straight, 1 = right (CONTEXT: Steuer-Intent). */
export type TurnSignal = -1 | 0 | 1;
