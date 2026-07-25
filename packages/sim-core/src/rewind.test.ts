import { BALANCE, LIMITS, TICK_DT_SEC, type Point } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { squareRing, territoryArea } from './geometry.js';
import { seedRng } from './rng.js';
import {
  cloneSimState,
  createSimState,
  hashSimState,
  type PlayerSim,
  type SimState,
} from './state.js';
import { step, type TickEvents, type TickInputs } from './step.js';

/**
 * Kill-fairness with rewind (ticket 07, spec §6.1, ADR-0003): the server
 * judges cuts and head-ons from the ACTING player's view — the opponent
 * state of `viewDelayTicks` ago — on top of the live judgment. All
 * scenarios here are hand-built geometry stepped through the real `step`,
 * so every hit and miss is exact arithmetic, not steering luck.
 */

/** Hand-built player literal (state shape is the public seam, cf. death.test). */
function player(
  id: number,
  x: number,
  y: number,
  heading: number,
  blockX: number,
  blockY: number,
): PlayerSim {
  return {
    id,
    x,
    y,
    heading,
    turn: 0,
    territory: [[squareRing(blockX, blockY, 3)]],
    trail: [],
    viewDelayTicks: 0,
    trailEpoch: 0,
    retiredTrails: [],
    history: [],
  };
}

function stateWith(...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: BALANCE.arena.sizeWU, players };
}

/** Run `ticks` steps, collecting each tick's events (inputs only on tick 0). */
function run(state: SimState, ticks: number, firstInputs: TickInputs = {}): TickEvents[] {
  const events: TickEvents[] = [];
  for (let t = 0; t < ticks; t++) {
    events.push(step(state, t === 0 ? firstInputs : {}, TICK_DT_SEC));
  }
  return events;
}

/**
 * The reset race (the ticket's core case): runner 2 returns home on a lane
 * 3.2 WU beside its outbound one and fills at tick 5 — its trail is gone.
 * Hunter 1 crosses the outbound lane (x = 98.5) at tick 7. Live judgment
 * misses (no trail any more); a hunter whose view lags 3 ticks saw the
 * trail where they crossed, so the cut must count (Gambetta rewind).
 */
function resetRace(): SimState {
  const runner = player(2, 101.7, 95.2, 1.5 * Math.PI, 100, 90);
  runner.trail = [
    [98.5, 92],
    [98.5, 108],
    [101.7, 108],
    [101.7, 95.2],
  ];
  const hunter = player(1, 95.2, 100, 0, 150, 100);
  return stateWith(hunter, runner);
}

describe('rewound trail cut (ticket 07: the cut counts from the actor’s view)', () => {
  it('a cut landing after the victim’s fill still kills when the actor’s view lags', () => {
    const state = resetRace();
    const events = run(state, 9, { views: [{ id: 1, viewDelayTicks: 3 }] });
    // The fill happened first (tick 5) …
    expect(events[4]?.fills).toEqual([2]);
    // … and the lagged cut still landed two ticks later — exactly once.
    expect(events[6]?.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'trailCut' }]);
    const total = events.flatMap((e) => e.deaths);
    expect(total).toHaveLength(1);
  });

  it('without rewind the same crossing misses — the trail was already gone', () => {
    const state = resetRace();
    const events = run(state, 11);
    expect(events[4]?.fills).toEqual([2]);
    expect(events.flatMap((e) => e.deaths)).toEqual([]);
  });

  it('a same-tick fill no longer saves the runner from a cut already seen by a lagged actor', () => {
    const state = resetRace();
    // Hunter starts 0.9 WU further along: cut range and fill land both at tick 5.
    const hunter = state.players[0];
    if (!hunter) throw new Error('hunter vanished');
    hunter.x = 96.1;
    const events = run(state, 6, { views: [{ id: 1, viewDelayTicks: 3 }] });
    expect(events[4]?.fills).toEqual([2]);
    expect(events[4]?.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'trailCut' }]);
    // Death applied after the fill: the runner respawned on a fresh block.
    const runner = state.players.find((p) => p.id === 2);
    expect(territoryArea(runner?.territory ?? [])).toBeCloseTo(36, 4);
  });
});

describe('a death ends the rewind past (no double death across lives)', () => {
  it('a lagged cut landing after the victim already died kills nobody', () => {
    // Runner 2 heads down along x=101.7 but its home block is far away —
    // no fill coming. Undelayed player 3 cuts the outbound lane (x=98.5)
    // live at tick 5: runner dies, respawns. Lagged hunter 1 crosses the
    // same lane at tick 7 — its screen still shows the trail, but that
    // life is over: judging it would kill the fresh spawn a second time.
    const runner = player(2, 101.7, 95.2, 1.5 * Math.PI, 100, 60);
    runner.trail = [
      [98.5, 92],
      [98.5, 108],
      [101.7, 108],
      [101.7, 95.2],
    ];
    const hunter = player(1, 95.2, 100, 0, 150, 100);
    const third = player(3, 95.9, 105, 0, 60, 100);
    const state = stateWith(hunter, runner, third);
    const events = run(state, 9, { views: [{ id: 1, viewDelayTicks: 3 }] });
    expect(events[4]?.deaths).toEqual([{ victimId: 2, killerId: 3, cause: 'trailCut' }]);
    expect(events.flatMap((e) => e.deaths)).toHaveLength(1);
    // The respawned life carries no rewindable past.
    const respawned = state.players.find((p) => p.id === 2);
    expect(respawned?.retiredTrails).toEqual([]);
  });
});

describe('rewound head-on (ticket 07: ramming the head you actually saw)', () => {
  it('touching an opponent’s viewed pose kills both when both stood outside', () => {
    // Opponent 2 runs +y along x=100 (trail behind); actor 1 runs a parallel
    // lane at x=100.8 — live distance stays 1.57 WU (> 1.0, no head-on) and
    // 0.8 WU off the trail line (> 0.5, no cut). But the 3-tick-old ghost of
    // player 2 sits exactly beside the actor: contact on the actor's screen.
    const o = player(2, 100, 105, Math.PI / 2, 100, 90);
    o.trail = [
      [100, 93],
      [100, 105],
    ];
    const a = player(1, 100.8, 103.65, Math.PI / 2, 150, 100);
    const state = stateWith(a, o);
    const events = run(state, 5, { views: [{ id: 1, viewDelayTicks: 3 }] });
    // First tick with a valid rewound entry is tick 4 (view = tick 1).
    expect(events[3]?.deaths).toEqual([
      { victimId: 2, killerId: 1, cause: 'headOn' },
      { victimId: 1, killerId: 2, cause: 'headOn' },
    ]);
    // No double death, ever: each victim exactly once across the run.
    const victims = events.flatMap((e) => e.deaths).map((d) => d.victimId);
    expect(victims.sort()).toEqual([1, 2]);
  });

  it('the same parallel lanes without rewind touch nothing', () => {
    const o = player(2, 100, 105, Math.PI / 2, 100, 90);
    o.trail = [
      [100, 93],
      [100, 105],
    ];
    const a = player(1, 100.8, 103.65, Math.PI / 2, 150, 100);
    const state = stateWith(a, o);
    expect(run(state, 8).flatMap((e) => e.deaths)).toEqual([]);
  });

  it('a runner caught outside dies even though it has since made it home', () => {
    // The shield is read at the VIEWED tick, not the live one (ADR-0003).
    // Runner 2 (the reset race above) is back inside its block and filling
    // at tick 5; hunter 1 comes in from the right along y = 93.5 and at tick
    // 6 stands 0.78 WU from the runner's tick-3 pose — which was still
    // outside. Past the retired trail's tip, so this is the head-on rule,
    // not a cut; and 1.22 WU from the runner's live head, so the live
    // head-on pass cannot reach it either.
    const state = resetRace();
    const hunter = state.players[0];
    if (!hunter) throw new Error('hunter vanished');
    Object.assign(hunter, { x: 105.1, y: 93.5, heading: Math.PI });
    hunter.territory = [[squareRing(130, 130, 3)]];
    const events = run(state, 5, { views: [{ id: 1, viewDelayTicks: 3 }] });
    expect(events[4]?.fills).toEqual([2]);
    const runner = state.players.find((p) => p.id === 2);
    // Sampled before the fatal tick — the death purges the whole history.
    expect(runner?.history.find((h) => h.tick === 3)?.safe).toBe(false);
    expect(runner?.history.find((h) => h.tick === 5)?.safe).toBe(true);

    // The runner dies although it is standing safely on its own land — and
    // the hunter dies with it: in the rewound frame both were out on foreign
    // ground, and both outside means both die (spec §2.1).
    expect(step(state, {}, TICK_DT_SEC).deaths).toEqual([
      { victimId: 2, killerId: 1, cause: 'headOn' },
      { victimId: 1, killerId: 2, cause: 'headOn' },
    ]);
  });

  it('two heads on their own adjacent lands spare each other, ghost included', () => {
    // Lanes 0.95 WU apart across the boundary between two blocks, offset
    // along the lane so that player 1's head lands exactly on player 2's
    // 3-tick-old pose. Both stay inside their own land the whole way, so
    // both shields hold — at the live tick AND at the viewed one.
    const p1 = player(1, 102.7, 100, Math.PI / 2, 100, 100);
    const p2 = player(2, 103.65, 101.35, Math.PI / 2, 106.5, 103);
    const state = stateWith(p1, p2);
    const events = run(state, 6, { views: [{ id: 1, viewDelayTicks: 3 }] });
    expect(events.flatMap((e) => e.deaths)).toEqual([]);
    const a = state.players.find((p) => p.id === 1);
    const b = state.players.find((p) => p.id === 2);
    if (!a || !b) throw new Error('players vanished');
    // Neither ever grew a trail, so nothing could be cut …
    expect([a.trail, b.trail]).toEqual([[], []]);
    // … and the sparing is not a near miss: the ghost player 1 was judged
    // against sat well inside the head-on diameter of its head.
    const ghost = b.history.find((h) => h.tick === state.tick - 3);
    if (!ghost) throw new Error('no ghost entry to check');
    expect(Math.hypot(a.x - ghost.x, a.y - ghost.y)).toBeLessThan(
      2 * BALANCE.trail.collisionRadiusWU,
    );
    expect(ghost.safe).toBe(true);
  });

  it('ramming the ghost of a head parked on its own land kills only the rammer', () => {
    // Opponent 2 cruises inside its own block (safe, spec §2.1); actor 1
    // dives at where it saw the head. The ghost was safe → the actor dies.
    const o = player(2, 98, 90, 0, 100, 90);
    const a = player(1, 98.9, 92.7, 1.5 * Math.PI, 150, 100);
    const state = stateWith(a, o);
    const events = run(state, 6, { views: [{ id: 1, viewDelayTicks: 3 }] });
    expect(events.flatMap((e) => e.deaths)).toEqual([
      { victimId: 1, killerId: 2, cause: 'headOn' },
    ]);
  });
});

describe('live head-on safety = standing on own land (the ticket-06 grace ends)', () => {
  it('two trail-less heads meeting on foreign ground die — trail-lessness is no shield', () => {
    // The post-enclosure transient (ticket 06): outside the own land with no
    // trail seeded yet. Under trail-emptiness safety both would read "safe";
    // inside-ness says both are out → beide draußen, beide tot (spec §2.1).
    const p1 = player(1, 120, 100, Math.PI / 2, 150, 100);
    const p2 = player(2, 120.8, 100, Math.PI / 2, 100, 90);
    const state = stateWith(p1, p2);
    const events = run(state, 1);
    expect(events[0]?.deaths).toEqual([
      { victimId: 1, killerId: 2, cause: 'headOn' },
      { victimId: 2, killerId: 1, cause: 'headOn' },
    ]);
  });
});

describe('history bookkeeping (rolling window, retirement GC, clamps)', () => {
  it('keeps exactly the rewind window of post-tick poses, newest last', () => {
    const state = createSimState(7);
    step(state, { joins: [1] }, TICK_DT_SEC);
    for (let t = 0; t < 14; t++) step(state, {}, TICK_DT_SEC);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    expect(p.history).toHaveLength(LIMITS.rewindMaxTicks);
    expect(p.history[0]?.tick).toBe(15 - LIMITS.rewindMaxTicks + 1);
    expect(p.history[p.history.length - 1]?.tick).toBe(15);
  });

  it('a retired trail stays for the window, then is garbage-collected', () => {
    const state = resetRace();
    run(state, 6); // fill at tick 5 retires the runner's trail
    const runner = state.players.find((p) => p.id === 2);
    if (!runner) throw new Error('runner vanished');
    expect(runner.retiredTrails).toHaveLength(1);
    expect(runner.trailEpoch).toBe(1);
    // Once no history entry references the old epoch, the trail is gone.
    for (let t = 0; t < LIMITS.rewindMaxTicks + 1; t++) step(state, {}, TICK_DT_SEC);
    expect(runner.retiredTrails).toEqual([]);
  });

  it('clamps hostile view delays into the rewind window', () => {
    const state = stateWith(player(1, 100, 100, 0, 100, 100));
    step(state, { views: [{ id: 1, viewDelayTicks: 99 }] }, TICK_DT_SEC);
    expect(state.players[0]?.viewDelayTicks).toBe(LIMITS.rewindMaxTicks);
    step(state, { views: [{ id: 1, viewDelayTicks: -5 }] }, TICK_DT_SEC);
    expect(state.players[0]?.viewDelayTicks).toBe(0);
    step(state, { views: [{ id: 1, viewDelayTicks: 2.7 }] }, TICK_DT_SEC);
    expect(state.players[0]?.viewDelayTicks).toBe(2);
    step(state, { views: [{ id: 1, viewDelayTicks: Number.NaN }] }, TICK_DT_SEC);
    expect(state.players[0]?.viewDelayTicks).toBe(0);
  });
});

describe('rewind stays replay-deterministic (ticket 07: no hash divergence)', () => {
  it('the reset race replays to a bit-identical hash', () => {
    const runOnce = (): string => {
      const state = resetRace();
      run(state, 9, { views: [{ id: 1, viewDelayTicks: 3 }] });
      return hashSimState(state);
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('the hash covers a retired trail while it is still rewindable', () => {
    const state = resetRace();
    run(state, 6); // fill at tick 5 retires the runner's trail
    const runner = state.players.find((p) => p.id === 2);
    expect(runner?.retiredTrails).toHaveLength(1);
    const hash = hashSimState(state);
    expect(hashSimState(state)).toBe(hash);
    // A retired trail is judgment input, so it is state: moving one of its
    // points must move the hash (else a rewind bug could hide from replay).
    const point = runner?.retiredTrails[0]?.points[0];
    if (!point) throw new Error('no retired trail point');
    const moved: Point = [point[0] + 1, point[1]];
    const tampered = cloneSimState(state);
    const victim = tampered.players.find((p) => p.id === 2);
    const retired = victim?.retiredTrails[0];
    if (!retired) throw new Error('clone lost the retired trail');
    retired.points = [moved, ...retired.points.slice(1)];
    expect(hashSimState(tampered)).not.toBe(hash);
  });

  it('a mid-race clone (history, retired trails and all) replays identically', () => {
    const original = resetRace();
    run(original, 6, { views: [{ id: 1, viewDelayTicks: 3 }] });
    const clone = cloneSimState(original);
    for (let t = 0; t < 4; t++) {
      step(original, {}, TICK_DT_SEC);
      step(clone, {}, TICK_DT_SEC);
    }
    expect(hashSimState(clone)).toBe(hashSimState(original));
  });

  it('any random script of turns AND view delays reproduces the hash', () => {
    const turnArb = fc.constantFrom<-1 | 0 | 1>(-1, 0, 1);
    const tickArb = fc.record({
      id: fc.integer({ min: 1, max: 3 }),
      turn: turnArb,
      delay: fc.integer({ min: 0, max: LIMITS.rewindMaxTicks }),
    });
    fc.assert(
      fc.property(fc.integer(), fc.array(tickArb, { maxLength: 150 }), (seed, script) => {
        const runOnce = (): string => {
          const state = createSimState(seed);
          step(state, { joins: [1, 2, 3] }, TICK_DT_SEC);
          for (const { id, turn, delay } of script) {
            step(
              state,
              { turns: [{ id, turn }], views: [{ id, viewDelayTicks: delay }] },
              TICK_DT_SEC,
            );
          }
          return hashSimState(state);
        };
        expect(runOnce()).toBe(runOnce());
      }),
      { numRuns: 25 },
    );
  });
});
