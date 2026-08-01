import { TICK_DT_SEC, TICK_HZ, type Ring, type TurnSignal } from '@paintclash/shared';
import { createSimState, step } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

import { LoopPilot, lobeWaypoints, ringCenter, roomiestDirection, steerToward } from './pilot.js';

/**
 * The load probe's premise, asserted without a network (the rule
 * `bench/fill-budget`'s smoke test lives by, and scenario README rule 2): if the
 * autopilot does not close loops, the production run would fly sixteen heads in
 * circles, measure an arena where nothing ever fills, and report a comfortable
 * tick budget for the wrong reason — which is precisely the failure mode
 * ticket 02's synthetic load already had once.
 *
 * Driven against a local `sim-core` through the same intent seam the wire uses:
 * a `TurnSignal` per player per tick, and nothing else.
 */
function fly(players: number, seconds: number, arenaSizeWU = 200): number {
  const state = createSimState(20260730, arenaSizeWU);
  const pilots = new Map<number, LoopPilot>();
  for (let id = 1; id <= players; id++) pilots.set(id, new LoopPilot(arenaSizeWU));
  let fills = 0;
  for (let tick = 0; tick < seconds * TICK_HZ; tick++) {
    const turns: { id: number; turn: TurnSignal }[] = [];
    for (const player of state.players) {
      const pilot = pilots.get(player.id);
      if (!pilot) continue;
      turns.push({
        id: player.id,
        turn: pilot.steer({ x: player.x, y: player.y, heading: player.heading }, player.territory),
      });
    }
    // The probe's clients are humans on the wire; here they are simply the
    // entities the sim was told to spawn on tick 0.
    const events = step(
      state,
      { botJoins: tick === 0 ? [...pilots.keys()] : [], turns },
      TICK_DT_SEC,
    );
    fills += events.fills.length;
  }
  return fills;
}

describe('loop autopilot', () => {
  it('paints: four heads close loops within a minute', () => {
    // Four rather than sixteen: the premise is "this pilot fills", and a
    // sixteen-head arena would additionally be testing that they survive each
    // other, which is the deployed arena's business, not this guard's.
    expect(fly(4, 60)).toBeGreaterThan(4);
  });

  it('keeps painting when the arena is crowded', () => {
    expect(fly(12, 60)).toBeGreaterThan(8);
  });

  it('flies straight, and forgets its plan, while it owns nothing', () => {
    const pilot = new LoopPilot(200);
    // A dead player's territory is empty until the respawn block syncs. A plan
    // drawn around the block it used to own would aim the head at ground that
    // now belongs to whoever took it.
    expect(pilot.steer({ x: 10, y: 10, heading: 0 }, [])).toBe(0);
    expect(pilot.lobesFlown).toBe(0);
  });

  it('steers the short way round', () => {
    const facingEast = { x: 0, y: 0, heading: 0 };
    expect(steerToward(facingEast, [10, 10])).toBe(1);
    expect(steerToward(facingEast, [10, -10])).toBe(-1);
    // Dead ahead is a straight line, not a wobble.
    expect(steerToward(facingEast, [10, 0])).toBe(0);
  });

  it('aims the lobe away from the nearest wall', () => {
    // Hard against the west wall: the tip needs room, so it must point east.
    expect(roomiestDirection([5, 100], 200)).toEqual([1, 0]);
    expect(roomiestDirection([195, 100], 200)).toEqual([-1, 0]);
    expect(roomiestDirection([100, 5], 200)).toEqual([0, 1]);
  });

  it('draws a lobe that leaves home and comes back to it', () => {
    const waypoints = lobeWaypoints([100, 100], [1, 0]);
    expect(waypoints[waypoints.length - 1]).toEqual([100, 100]);
    // The tip is genuinely out there — a lobe that never leaves the block
    // encloses nothing and fills nothing.
    const tip = waypoints[1] ?? [0, 0];
    expect(Math.hypot(tip[0] - 100, tip[1] - 100)).toBeGreaterThan(15);
  });

  it('takes the centre of the block it owns as home', () => {
    const square: Ring = [
      [0, 0],
      [6, 0],
      [6, 6],
      [0, 6],
    ];
    expect(ringCenter([[square]])).toEqual([3, 3]);
    expect(ringCenter([])).toBeNull();
  });
});
