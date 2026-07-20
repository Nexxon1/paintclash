/**
 * The pure simulation step (ADR-0003): fixed dt, no clock, no I/O — the same
 * function runs authoritatively in the Arena-DO and as prediction in the
 * browser. Mutates the passed state in place (hot path, 20 Hz × N players);
 * callers that need history clone first (`cloneSimState`).
 */

import { BALANCE } from '@paintclash/shared';

import { nextRandom } from './rng.js';
import type { PlayerSim, SimState, TurnSignal } from './state.js';

/** Everything that can happen in one tick, in processing order. */
export interface TickInputs {
  /** Player ids to spawn this tick (already-present ids are ignored). */
  joins?: readonly number[];
  /** Player ids to remove this tick. */
  leaves?: readonly number[];
  /** Steer intents; multiple per id coalesce to the last one (spec §8.3). */
  turns?: readonly { id: number; turn: TurnSignal }[];
}

const TURN_RATE_RAD = (BALANCE.movement.turnRateDegPerSec * Math.PI) / 180;
const TWO_PI = 2 * Math.PI;
/** Spawn candidates drawn before settling for the best available spot. */
const SPAWN_TRIES = 16;

/**
 * Advance one player by one fixed timestep: clamp the turn, move at constant
 * speed, slide along the soft barrier. Exactly this function is what client
 * prediction replays — server and client cannot drift (ADR-0002/0003).
 */
export function advancePlayer(p: PlayerSim, arenaSizeWU: number, dtSec: number): void {
  let heading = p.heading + p.turn * TURN_RATE_RAD * dtSec;
  heading %= TWO_PI;
  if (heading < 0) heading += TWO_PI;
  p.heading = heading;
  const stepWU = BALANCE.movement.speedWuPerSec * dtSec;
  // Soft barrier (spec §2.4): clamping preserves the along-wall velocity
  // component, so the head glides along the edge instead of dying or sticking.
  p.x = Math.min(arenaSizeWU, Math.max(0, p.x + Math.cos(heading) * stepWU));
  p.y = Math.min(arenaSizeWU, Math.max(0, p.y + Math.sin(heading) * stepWU));
}

/** Distance from a point to the closest threat of an existing player. */
function distanceToPlayer(x: number, y: number, p: PlayerSim): number {
  const toHead = Math.hypot(x - p.x, y - p.y);
  // Territory counts too (spec §2.3): approximate the 6×6 block by its
  // circumscribed circle around the block center.
  const blockRadius = (BALANCE.spawn.startBlockWU / 2) * Math.SQRT2;
  const toBlock = Math.hypot(x - p.blockCx, y - p.blockCy) - blockRadius;
  return Math.min(toHead, toBlock);
}

/**
 * Pick a spawn spot: random candidates, first that honors the 25 WU minimum
 * distance wins; under crowding the best candidate found wins instead of
 * failing (spec §2.3 "bestmögliche freie Stelle").
 */
function spawnPlayer(state: SimState, id: number): void {
  // An arena smaller than the start block (tiny private rooms) must still
  // spawn inside — clamp the block to what fits.
  const blockWU = Math.min(BALANCE.spawn.startBlockWU, state.arenaSizeWU);
  const half = blockWU / 2;
  const range = Math.max(0, state.arenaSizeWU - blockWU);
  let bestX = state.arenaSizeWU / 2;
  let bestY = state.arenaSizeWU / 2;
  let bestDist = -Infinity;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const rx = nextRandom(state.rng);
    const ry = nextRandom(rx.state);
    state.rng = ry.state;
    const x = half + rx.value * range;
    const y = half + ry.value * range;
    let minDist = Infinity;
    for (const p of state.players) {
      minDist = Math.min(minDist, distanceToPlayer(x, y, p));
    }
    if (minDist > bestDist) {
      bestDist = minDist;
      bestX = x;
      bestY = y;
    }
    if (minDist >= BALANCE.spawn.minDistanceWU) break;
  }
  const rh = nextRandom(state.rng);
  state.rng = rh.state;
  state.players.push({
    id,
    x: bestX,
    y: bestY,
    heading: rh.value * TWO_PI,
    turn: 0,
    blockCx: bestX,
    blockCy: bestY,
  });
}

/** One authoritative tick: leaves → joins → intents → movement. */
export function step(state: SimState, inputs: TickInputs, dtSec: number): void {
  if (inputs.leaves) {
    for (const id of inputs.leaves) {
      const idx = state.players.findIndex((p) => p.id === id);
      if (idx !== -1) state.players.splice(idx, 1);
    }
  }
  if (inputs.joins) {
    for (const id of inputs.joins) {
      if (!state.players.some((p) => p.id === id)) spawnPlayer(state, id);
    }
  }
  if (inputs.turns) {
    for (const { id, turn } of inputs.turns) {
      const p = state.players.find((q) => q.id === id);
      if (p) p.turn = turn;
    }
  }
  for (const p of state.players) {
    advancePlayer(p, state.arenaSizeWU, dtSec);
  }
  state.tick += 1;
}
