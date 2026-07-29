/**
 * `sim-core` — pure, deterministic game logic shared verbatim between the
 * authoritative server and client prediction (ADR-0002/0003). No network, no
 * rendering, no wall clock and no ambient RNG.
 */
export { detectDeaths, type Death, type DeathContext } from './collision.js';
export { closeLoop, type FillOutcome } from './fill.js';
export { pointInTerritory, territoryArea } from './geometry.js';
export { type RewoundView } from './history.js';
export { mapSharePct, standings, type Standing } from './leaderboard.js';
export { nextRandom, seedRng, type RngState } from './rng.js';
export {
  lifeScore,
  lifeStats,
  type LifeCounters,
  type LifeScoreInput,
  type LifeStats,
} from './score.js';
export {
  cloneSimState,
  createSimState,
  hashSimState,
  type HeadPose,
  type PlayerSim,
  type Point,
  type PoseHistoryEntry,
  type RetiredTrail,
  type SimState,
  type Territory,
  type TurnSignal,
} from './state.js';
export { advancePlayer, step, type TickEvents, type TickInputs } from './step.js';
