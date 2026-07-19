/**
 * `sim-core` — pure, deterministic game logic shared verbatim between the
 * authoritative server and client prediction (ADR-0002/0003). No network, no
 * rendering, no wall clock and no ambient RNG.
 */
export { nextRandom, seedRng, type RngState } from './rng.js';
export {
  cloneSimState,
  createSimState,
  hashSimState,
  type PlayerSim,
  type SimState,
  type TurnSignal,
} from './state.js';
export { advancePlayer, step, type TickInputs } from './step.js';
