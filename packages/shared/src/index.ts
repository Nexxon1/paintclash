/**
 * `shared` — single source of truth for balance parameters (spec §10) and
 * cross-package constants/types (incl. the 20 Hz tick).
 *
 * @see spec §5.1, ADR-0002
 */
export { BALANCE, TICK_DT_MS, TICK_DT_SEC, TICK_HZ } from './balance.js';
export { LIMITS } from './limits.js';
export type { TurnSignal } from './types.js';
