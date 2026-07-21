/**
 * `sim-core` — pure, deterministic game logic shared verbatim between the
 * authoritative server and client prediction (ADR-0002/0003). No network, no
 * rendering, no wall clock and no ambient RNG.
 */
export { closeLoop, type FillOutcome } from './fill.js';
export { appendTrailPoint, pointInTerritory, territoryArea } from './geometry.js';
export { nextRandom, seedRng, type RngState } from './rng.js';
export {
  cloneSimState,
  createSimState,
  hashSimState,
  type HeadPose,
  type PlayerSim,
  type Point,
  type SimState,
  type Territory,
  type TurnSignal,
} from './state.js';
export { advancePlayer, step, type TickEvents, type TickInputs } from './step.js';
