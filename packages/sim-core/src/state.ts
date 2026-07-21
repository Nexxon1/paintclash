/**
 * Sim state — plain, cloneable data. The shape is part of the public seam:
 * server, client prediction and tests all build and read it directly
 * (ADR-0002: one shared truth, ADR-0003: pure step over this state).
 */

import { BALANCE, type Point, type Territory, type TurnSignal } from '@paintclash/shared';

import { cloneTerritory } from './geometry.js';
import { seedRng, type RngState } from './rng.js';

export type { Point, Territory, TurnSignal };

/**
 * The pose fields movement acts on — exactly what client prediction replays
 * (spec §6.1). Kept separate from `PlayerSim` so the predictor never has to
 * fake a territory.
 */
export interface HeadPose {
  /** Head position in WU. */
  x: number;
  y: number;
  /** Heading in radians, kept in [0, 2π). */
  heading: number;
  /** Last received steer intent — persists until replaced (coalescing). */
  turn: TurnSignal;
}

export interface PlayerSim extends HeadPose {
  id: number;
  /** Owned land (CONTEXT: Gebiet); starts as the 6×6 spawn block. */
  territory: Territory;
  /**
   * Path since leaving the own territory (CONTEXT: Trail); empty while
   * inside. First point is the last pose *inside* — the loop ring connects
   * to the territory without on-boundary degeneracy.
   */
  trail: Point[];
}

export interface SimState {
  /** Completed simulation ticks since arena start. */
  tick: number;
  /** Injected seeded RNG state — the only randomness in the sim. */
  rng: RngState;
  /** Arena edge length in WU (public arena default; private rooms differ). */
  arenaSizeWU: number;
  /** Join order; array order is the stable iteration order (ADR-0003). */
  players: PlayerSim[];
}

/** Fresh arena state from a seed. */
export function createSimState(seed: number, arenaSizeWU: number = BALANCE.arena.sizeWU): SimState {
  return { tick: 0, rng: seedRng(seed), arenaSizeWU, players: [] };
}

/** Deep copy — prediction and rewind re-simulate on clones. */
export function cloneSimState(state: SimState): SimState {
  return {
    tick: state.tick,
    rng: state.rng,
    arenaSizeWU: state.arenaSizeWU,
    players: state.players.map((p) => ({
      ...p,
      territory: cloneTerritory(p.territory),
      trail: p.trail.map((q): Point => [q[0], q[1]]),
    })),
  };
}

/**
 * Canonical FNV-1a hash over every state bit. Two states hash equal iff the
 * replay was bit-identical — the property the replay-determinism tests pin
 * down (spec §9.2). Structure counts (polys/rings/points) are hashed too, so
 * differently-shaped geometry can never collide by coordinate coincidence.
 */
export function hashSimState(state: SimState): string {
  const numbers: number[] = [state.tick, state.rng, state.arenaSizeWU];
  for (const p of state.players) {
    numbers.push(p.id, p.x, p.y, p.heading, p.turn);
    numbers.push(p.territory.length);
    for (const poly of p.territory) {
      numbers.push(poly.length);
      for (const ring of poly) {
        numbers.push(ring.length);
        for (const [x, y] of ring) numbers.push(x, y);
      }
    }
    numbers.push(p.trail.length);
    for (const [x, y] of p.trail) numbers.push(x, y);
  }
  const bytes = new DataView(new ArrayBuffer(numbers.length * 8));
  numbers.forEach((n, i) => {
    bytes.setFloat64(i * 8, n, true);
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes.getUint8(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
