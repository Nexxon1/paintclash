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

/**
 * One post-tick pose in the rolling rewind history (ticket 07) — exactly
 * what the snapshot of `tick` broadcast, so a rewound judgment recreates
 * what the acting player's screen showed.
 */
export interface PoseHistoryEntry {
  tick: number;
  x: number;
  y: number;
  /** Stood on own land (head-on shield, spec §2.1) at that tick. */
  safe: boolean;
  /** Trail point count at that tick — keys the prefix reconstruction. */
  trailLen: number;
  /** Trail generation the entry belongs to (see PlayerSim.trailEpoch). */
  trailEpoch: number;
}

/**
 * A trail reset within the rewind window (fill or death), kept frozen so a
 * lagged actor's cut can still be judged against it (ticket 07). Dropped as
 * soon as no history entry references its epoch.
 */
export interface RetiredTrail {
  epoch: number;
  points: readonly Point[];
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
  /**
   * How many ticks this player's pilot sees opponents in the past (ticket
   * 07 rewind) — input-persisted like `turn`, clamped to
   * `LIMITS.rewindMaxTicks`; 0 judges live only (fresh spawns, bots).
   */
  viewDelayTicks: number;
  /** Trail generation — bumps on every trail reset, keying retired trails. */
  trailEpoch: number;
  /** Recently reset trails, garbage-collected by history reachability. */
  retiredTrails: RetiredTrail[];
  /** Rolling post-tick pose window, newest last (ticket 07 rewind). */
  history: PoseHistoryEntry[];
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
      retiredTrails: p.retiredTrails.map((r) => ({
        epoch: r.epoch,
        points: r.points.map((q): Point => [q[0], q[1]]),
      })),
      history: p.history.map((h) => ({ ...h })),
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
    numbers.push(p.id, p.x, p.y, p.heading, p.turn, p.viewDelayTicks, p.trailEpoch);
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
    numbers.push(p.retiredTrails.length);
    for (const r of p.retiredTrails) {
      numbers.push(r.epoch, r.points.length);
      for (const [x, y] of r.points) numbers.push(x, y);
    }
    numbers.push(p.history.length);
    for (const h of p.history) {
      numbers.push(h.tick, h.x, h.y, h.safe ? 1 : 0, h.trailLen, h.trailEpoch);
    }
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
