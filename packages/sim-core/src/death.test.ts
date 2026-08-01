import { BALANCE, TICK_DT_SEC, type Territory } from '@paintclash/shared';
import fc from 'fast-check';
import { intersection } from 'polyclip-ts';
import { describe, expect, it } from 'vitest';

import { LATTICE_NOISE_WU2 } from './fixtures/tolerances.js';
import { pointInTerritory, squareRing, territoryArea } from './geometry.js';
import { seedRng } from './rng.js';
import { createSimState, type PlayerSim, type SimState } from './state.js';
import { step, type TickEvents } from './step.js';

/**
 * A hand-built player literal (the state shape is part of the public seam):
 * head at (x, y), territory block centered at (blockX, blockY) — placed away
 * from the head for trail-carrying players, or around it for safe ones.
 */
function player(
  id: number,
  x: number,
  y: number,
  heading: number,
  blockX: number,
  blockY: number,
  turn: -1 | 0 | 1 = 0,
): PlayerSim {
  return {
    id,
    x,
    y,
    heading,
    turn,
    territory: [[squareRing(blockX, blockY, 3)]],
    trail: [],
    viewDelayTicks: 0,
    trailEpoch: 0,
    retiredTrails: [],
    history: [],
    isBot: false,
    lifeTicks: 0,
    peakPct: 0,
    otherHumanTicks: 0,
  };
}

function stateWith(...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: BALANCE.arena.sizeWU, players };
}

/** Post-death invariants of one respawned victim (spec §2.1/2.3). */
function expectRespawned(p: PlayerSim): void {
  expect(territoryArea(p.territory)).toBeCloseTo(BALANCE.spawn.startBlockWU ** 2, 4);
  expect(p.trail).toHaveLength(0);
  expect(pointInTerritory(p.x, p.y, p.territory)).toBe(true);
}

describe('trail cut (spec §2.1: cutting a trail kills its owner)', () => {
  it('an enemy head crossing a trail kills the trail owner, who respawns fresh', () => {
    // B's trail is the line x=100, y ∈ [92, 115.45] (post-move); A drives to
    // x=99.55 at y=110 — 0.45 WU from the trail, inside the 0.5 WU radius.
    const b = player(2, 100, 115, Math.PI / 2, 100, 90);
    b.trail = [
      [100, 92],
      [100, 115],
    ];
    const a = player(1, 99.1, 110, 0, 85, 110);
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'trailCut' }]);
    const [alive, victim] = state.players;
    if (!alive || !victim) throw new Error('players vanished');
    // The killer is untouched, the victim's old land is gone (neutral).
    expect(alive.id).toBe(1);
    expect(territoryArea(alive.territory)).toBeCloseTo(36, 6);
    expect(victim.id).toBe(2);
    expect(pointInTerritory(100, 90, victim.territory)).toBe(false);
    expectRespawned(victim);
  });

  it('a head clearly beyond the collision radius does not cut', () => {
    const b = player(2, 100, 115, Math.PI / 2, 100, 90);
    b.trail = [
      [100, 92],
      [100, 115],
    ];
    // Post-move x = 98.55 — 1.45 WU from the trail line.
    const a = player(1, 98.1, 110, 0, 85, 110);
    const state = stateWith(a, b);
    expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
  });

  it('chasing directly on a trail kills only the trail owner, even inside head-on range', () => {
    // A rides exactly on B's trail line, 0.9 WU behind B's head post-move:
    // the cut resolves first, so B's head never drags A into a head-on death.
    const b = player(2, 110, 100, 0, 100, 100);
    b.trail = [
      [102.8, 100],
      [110, 100],
    ];
    const a = player(1, 109.1, 100, 0, 95, 110);
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'trailCut' }]);
    // The chaser survives with its own trail intact.
    expect(state.players.find((p) => p.id === 1)?.trail.length).toBeGreaterThan(0);
  });

  it('a head parked safely inside its own land still cuts a trail crossing it', () => {
    // B's trail crosses straight through A's block; A never leaves home.
    const a = player(1, 100, 100, 0, 100, 100);
    const b = player(2, 100.45, 110, Math.PI / 2, 120, 100);
    b.trail = [
      [118, 95],
      [100.45, 95],
      [100.45, 110],
    ];
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'trailCut' }]);
    // The safe head keeps its land.
    expect(territoryArea(state.players[0]?.territory ?? [])).toBeCloseTo(36, 6);
  });

  it('two heads cutting each other’s trails in the same tick both die', () => {
    // A moves up the line x=100; B moves right along y=110.45. Post-move,
    // each head sits 0.05 WU from the other's trail — simultaneous cuts.
    const a = player(1, 100, 110, Math.PI / 2, 85, 100);
    a.trail = [
      [100, 95],
      [100, 110],
    ];
    const b = player(2, 99.5, 110.45, 0, 115, 100);
    b.trail = [
      [95, 110.45],
      [99.5, 110.45],
    ];
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toHaveLength(2);
    expect(new Set(events.deaths.map((d) => d.victimId))).toEqual(new Set([1, 2]));
    for (const death of events.deaths) expect(death.cause).toBe('trailCut');
  });
});

/**
 * Since ticket 19 the self-cut is a *crossing* test, not a proximity test
 * with a grace window: the tick's movement segment kills only where it
 * transversally crosses an own trail segment. Every case below is one half of
 * that rule.
 */
describe('self cut (spec §2.1: your own trail kills you too)', () => {
  /** Step until someone dies, or `ticks` have passed without a death. */
  function stepUntilDeath(state: SimState, ticks: number): TickEvents['deaths'] {
    for (let t = 0; t < ticks; t++) {
      const { deaths } = step(state, {}, TICK_DT_SEC);
      if (deaths.length > 0) return deaths;
    }
    return [];
  }

  it('driving straight never dies on the trail glued to the head', () => {
    const p = player(1, 110, 100, 0, 100, 100);
    const state = stateWith(p);
    for (let t = 0; t < 30; t++) {
      expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
    }
  });

  it('closing a full circle onto the own trail is a self-kill', () => {
    // Held turn at max rate: full circle ≈ 22.5 ticks (r ≈ 1.61 WU), well
    // clear of the own block — the head comes around and crosses the trail's
    // first segment, whatever the path length says.
    const p = player(1, 110, 110, 0, 100, 100, 1);
    const state = stateWith(p);
    expect(stepUntilDeath(state, 30)).toEqual([{ victimId: 1, killerId: 1, cause: 'trailCut' }]);
    const respawned = state.players[0];
    if (!respawned) throw new Error('player vanished');
    expectRespawned(respawned);
  });

  it('a teardrop crossing its own outbound line far behind the head dies', () => {
    // Hand-built excursion: up the line x=100, across the top, down x=94 —
    // then the head drives east and must cut the outbound leg at (100, 100),
    // ~24 WU of path behind it. Path length is irrelevant now; the crossing
    // is the whole rule.
    const p = player(1, 94, 100, 0, 100, 85);
    p.trail = [
      [100, 88],
      [100, 112],
      [94, 112],
      [94, 100],
    ];
    const state = stateWith(p);
    // 6 WU east at 0.45 WU/tick — the 14th tick carries the head past x=100.
    expect(stepUntilDeath(state, 13)).toEqual([]);
    expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([
      { victimId: 1, killerId: 1, cause: 'trailCut' },
    ]);
  });

  it('turning away from the wall while pinned is NOT a self-kill (soft barrier, spec §2.4)', () => {
    // Pinned against the top wall with a held turn, the clamp slides the head
    // back over its own just-laid wall trail. That reversal is *collinear*
    // overlap, never a crossing — or the soft barrier would be an edge death
    // in disguise.
    const p = player(1, 110, BALANCE.arena.sizeWU, 0.698, 110, 185, 1);
    const state = stateWith(p);
    for (let t = 0; t < 14; t++) {
      expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
    }
  });

  it('jittering along the wall over many passes never dies (ticket 05 watch item)', () => {
    // Sweeping the heading up through the wall and back down again keeps the
    // head pinned while the clamp drags it right, then left, then right over
    // the wall trail it laid — twelve cycles, ~7 WU of path each. This is
    // watch item (a) of ticket 05: the old grace window covered only the last
    // 4.5 WU of path, so from the first reversal onwards every re-pass was a
    // death at proximity 0. As a crossing test they are all collinear
    // overlap, and collinear is never a crossing.
    const p = player(1, 40, BALANCE.arena.sizeWU, 0.698, 40, 185, 1);
    const state = stateWith(p);
    const cycles = 12;
    const halfCycleTicks = 8; // 8 × 16° sweeps the heading across the wall
    for (let cycle = 0; cycle < cycles; cycle++) {
      for (const turn of [1, -1] as const) {
        for (let t = 0; t < halfCycleTicks; t++) {
          expect(step(state, { turns: [{ id: 1, turn }] }, TICK_DT_SEC).deaths).toEqual([]);
          // The premise: the head never left the wall, so nothing it survived
          // was survived by being somewhere else.
          expect(state.players[0]?.y).toBe(BALANCE.arena.sizeWU);
        }
      }
    }
    // …and it really did lay pass after pass along the wall line, rather than
    // one compacted run: every reversal is its own point at y = 200.
    const onWall = state.players[0]?.trail.filter(([, y]) => y === BALANCE.arena.sizeWU) ?? [];
    expect(onWall.length).toBeGreaterThan(2 * cycles);
  });

  it('sliding along the wall over the tip of an earlier leg survives — the wall has no far side', () => {
    // Hand-built: an excursion that reached the top wall at (60, 200), ran
    // east along it, boxed back down and came home to (50, 200), where the
    // head now sits pinned and drives east straight over its own outbound tip.
    //
    // A proper-crossing test is blind to a hit landing exactly on a trail
    // VERTEX, and the wall clamp makes those hits systematic rather than a
    // float coincidence: every pinned point carries y = 200 exactly. At the
    // wall that blindness is also correct — nothing reaches y > 200, so the
    // leg being "hit" has no far side to cross to: west of x = 60 the leg
    // runs below the head, east of it the trail lies exactly under it. The
    // head merges with its own line and splits off again, which is the same
    // collinear overlap the pinned slide already survives.
    const wall = BALANCE.arena.sizeWU;
    const p = player(1, 50, wall, 0, 40, 170);
    p.trail = [
      [40, 173],
      [60, wall],
      [70, wall],
      [70, 180],
      [50, 180],
      [50, wall],
    ];
    const state = stateWith(p);
    for (let t = 0; t < 40; t++) {
      expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
    }
    // The premise: it really did stay pinned and drive past the tip at x = 60.
    expect(state.players[0]?.y).toBe(wall);
    expect(state.players[0]?.x).toBeGreaterThan(60);
  });

  it('running alongside the own trail inside the collision band survives', () => {
    // The deliberate trade of ticket 19: for the OWN trail the centerline is
    // the kill line, not the rendered band. A head 0.2 WU beside its own line
    // overlaps it visually and used to die once past the grace window — now
    // only actually crossing it does.
    const p = player(1, 99.8, 112, -Math.PI / 2, 100, 85);
    p.trail = [
      [100, 88],
      [100, 112],
      [99.8, 112],
    ];
    const state = stateWith(p);
    for (let t = 0; t < 40; t++) {
      expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
    }
    // The premise: it really did run the length of its own outbound leg.
    expect(state.players[0]?.y).toBeLessThan(94);
  });
});

describe('head-on (spec §2.1: outside dies, own land is safe)', () => {
  it('both outside → both die and respawn', () => {
    const a = player(1, 98.6, 100, 0, 80, 100);
    const b = player(2, 100.4, 100, Math.PI, 120, 100);
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toHaveLength(2);
    expect(events.deaths.map((d) => d.cause)).toEqual(['headOn', 'headOn']);
    expect(new Set(events.deaths.map((d) => d.victimId))).toEqual(new Set([1, 2]));
    // Killers point at each other.
    for (const death of events.deaths) {
      expect(death.killerId).toBe(death.victimId === 1 ? 2 : 1);
    }
    for (const p of state.players) expectRespawned(p);
  });

  it('heads beyond twice the collision radius pass unharmed', () => {
    const a = player(1, 97.5, 100, 0, 80, 100);
    const b = player(2, 101.5, 100, Math.PI, 120, 100);
    const state = stateWith(a, b);
    // Post-move gap: 101.05 − 97.95 = 3.1 WU.
    expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
  });

  it('the head inside its own territory is safe; the outsider dies', () => {
    const b = player(2, 101, 100, 0, 101, 100); // stays inside its block
    const a = player(1, 101.45, 101.35, (3 * Math.PI) / 2, 85, 110);
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.deaths).toEqual([{ victimId: 1, killerId: 2, cause: 'headOn' }]);
    // The safe defender keeps land and trail-lessness.
    const defender = state.players.find((p) => p.id === 2);
    expect(territoryArea(defender?.territory ?? [])).toBeCloseTo(36, 6);
    expect(defender?.trail).toHaveLength(0);
  });

  it('two heads each inside their own adjacent land touch without dying', () => {
    const a = player(1, 102.5, 100, 0, 100, 100);
    const b = player(2, 103.6, 100, Math.PI, 106, 100);
    const state = stateWith(a, b);
    // Post-move gap 0.2 WU across the shared border at x=103 — both safe.
    expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([]);
  });

  it('a landless player counts as outside and can die head-on', () => {
    const a = player(1, 98.6, 100, 0, 80, 100);
    const b = player(2, 100.4, 100, Math.PI, 120, 100);
    b.territory = [];
    const state = stateWith(a, b);
    const events = step(state, {}, TICK_DT_SEC);
    expect(new Set(events.deaths.map((d) => d.victimId))).toEqual(new Set([1, 2]));
  });
});

describe('death consequences (property: Tod ⇒ Gebiet komplett neutral)', () => {
  const turnArb = fc.constantFrom<-1 | 0 | 1>(-1, 0, 1);

  it('every death replaces the victim’s land with exactly a fresh start block', () => {
    let sawDeath = false;
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 3 }), turn: turnArb }), {
          minLength: 100,
          maxLength: 300,
        }),
        (seed, intents) => {
          // Tiny arena → trails cross constantly → deaths actually happen.
          const arena = 30;
          const state = createSimState(seed, arena);
          step(state, { joins: [1, 2, 3] }, TICK_DT_SEC);
          for (const intent of intents) {
            const events = step(state, { turns: [intent] }, TICK_DT_SEC);
            for (const death of events.deaths) {
              sawDeath = true;
              const victim = state.players.find((p) => p.id === death.victimId);
              if (!victim) throw new Error('victim vanished');
              // The old land is fully relinquished: all that remains is the
              // fresh start block (possibly carved under crowding).
              expect(territoryArea(victim.territory)).toBeLessThanOrEqual(
                BALANCE.spawn.startBlockWU ** 2 + 1e-6,
              );
              expect(victim.trail).toHaveLength(0);
              // Every death names a killer (self-cuts name the victim).
              expect(death.killerId).toBeGreaterThanOrEqual(1);
            }
            // Owned + neutral = 100 % stays intact through deaths.
            let total = 0;
            for (const p of state.players) total += territoryArea(p.territory);
            expect(total).toBeLessThanOrEqual(arena * arena + LATTICE_NOISE_WU2);
          }
          // Pairwise disjoint at the end — respawns never overlap owned land.
          for (let i = 0; i < state.players.length; i++) {
            for (let j = i + 1; j < state.players.length; j++) {
              const a = state.players[i]?.territory ?? [];
              const b = state.players[j]?.territory ?? [];
              expect(territoryArea(intersection(a, b) as Territory)).toBeLessThanOrEqual(
                LATTICE_NOISE_WU2,
              );
            }
          }
        },
      ),
      { numRuns: 25 },
    );
    // The property is vacuous unless the random play actually killed someone.
    expect(sawDeath).toBe(true);
  });

  it('death and respawn are deterministic for a given seed', () => {
    const run = (): SimState => {
      const state = createSimState(42, 30);
      step(state, { joins: [1, 2] }, TICK_DT_SEC);
      for (let t = 0; t < 120; t++) {
        step(state, { turns: [{ id: 1, turn: 1 }] }, TICK_DT_SEC);
      }
      return state;
    };
    expect(run()).toEqual(run());
  });
});
