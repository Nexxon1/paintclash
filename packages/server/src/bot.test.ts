import { BALANCE, TICK_DT_SEC, type Point, type Ring } from '@paintclash/shared';
import {
  createSimState,
  seedRng,
  step,
  territoryArea,
  type Death,
  type PlayerSim,
  type SimState,
} from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

import { BotPilot, senseFor } from './bot.js';

/** Axis-aligned CCW square ring — a start block, as the sim spawns them. */
function block(cx: number, cy: number, half = BALANCE.spawn.startBlockWU / 2): Ring {
  return [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
}

/**
 * A hand-built bot (the sim state shape is a public seam — same literal the
 * sim-core tests use): head at (x, y), 6×6 block centered on (blockX, blockY).
 */
function bot(id: number, x: number, y: number, heading: number, blockX = x, blockY = y): PlayerSim {
  return {
    id,
    x,
    y,
    heading,
    turn: 0,
    territory: [[block(blockX, blockY)]],
    trail: [],
    viewDelayTicks: 0,
    trailEpoch: 0,
    retiredTrails: [],
    history: [],
    isBot: true,
    lifeTicks: 0,
    peakPct: 0,
    otherHumanTicks: 0,
  };
}

function smallArenaWith(sizeWU: number, ...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: sizeWU, players };
}

function stateWith(...players: PlayerSim[]): SimState {
  return smallArenaWith(BALANCE.arena.sizeWU, ...players);
}

/**
 * Fly the given bots through the REAL sim for `ticks` ticks, each steered only
 * by its pilot's view — the seam the arena uses in production, so what passes
 * here is what plays there. Reports the deaths and the loops each bot closed —
 * the latter only from `countFillsAfter` on, so a test can ask "was it STILL
 * playing at the end?" instead of "did it ever play?".
 */
function flyBots(
  state: SimState,
  ticks: number,
  countFillsAfter = 0,
): { deaths: Death[]; fills: Map<number, number> } {
  const pilots = new Map(
    state.players.filter((p) => p.isBot).map((p) => [p.id, new BotPilot(p.id)]),
  );
  const deaths: Death[] = [];
  const fills = new Map<number, number>([...pilots.keys()].map((id) => [id, 0]));
  for (let i = 0; i < ticks; i++) {
    const turns = [...pilots].flatMap(([id, pilot]) => {
      const sight = senseFor(state, id);
      return sight ? [{ id, turn: pilot.steer(sight) }] : [];
    });
    const events = step(state, { turns }, TICK_DT_SEC);
    deaths.push(...events.deaths);
    if (i >= countFillsAfter) {
      for (const id of events.fills) fills.set(id, (fills.get(id) ?? 0) + 1);
    }
  }
  return { deaths, fills };
}

const START_BLOCK_AREA = BALANCE.spawn.startBlockWU ** 2;

describe('the core loop (ticket 12: out, close the loop, fill)', () => {
  it('an undisturbed bot paints: it leaves home, closes a loop and gains land', () => {
    const state = stateWith(bot(1, 100, 100, 0));
    const { deaths, fills } = flyBots(state, 200);
    const area = territoryArea(state.players[0]?.territory ?? []);
    expect(deaths, 'an undisturbed bot must not die').toEqual([]);
    expect(fills.get(1), 'loops closed in 10 s').toBeGreaterThan(0);
    expect(area, `area after 10 s: ${area.toFixed(1)} WU²`).toBeGreaterThan(START_BLOCK_AREA + 60);
  });

  it('paints in an arena smaller than its own excursion', () => {
    // Every one of the eight candidate lobes overshoots a 30 WU arena (the
    // excursion alone is 18 WU from the centre), so each one's waypoints lie
    // OUTSIDE the world. That is the second way a bot used to park forever: the
    // barrier holds the head, an out-of-arena waypoint is never "reached", and a
    // pinned head lays no new trail so the exposure cap never fires either.
    // Waypoints are therefore flown clamped — while still being SCORED raw, so
    // the choice can tell that a lobe runs into the wall.
    const state = smallArenaWith(30, bot(1, 15, 15, 0));
    const { fills } = flyBots(state, 400, 200);
    expect(fills.get(1), 'loops closed in the last 10 s of a 30 WU arena').toBeGreaterThan(0);
  });

  it('paints from a corner too — never presses into the soft barrier instead', () => {
    // A start block in the corner of a small arena (private-room sized): every
    // full-size lobe reaches past the edge, so the pilot has to plan around the
    // barrier rather than into it.
    const state = smallArenaWith(60, bot(1, 8, 8, 0));
    const { deaths, fills } = flyBots(state, 400);
    const area = territoryArea(state.players[0]?.territory ?? []);
    expect(deaths, 'a cornered bot must not die of it').toEqual([]);
    expect(fills.get(1), 'loops closed from the corner in 20 s').toBeGreaterThan(0);
    expect(area, `corner area after 20 s: ${area.toFixed(1)} WU²`).toBeGreaterThan(
      START_BLOCK_AREA + 30,
    );
  });

  // A SMOKE test, and knowingly a weak one. Both stall mechanisms found so far
  // have their own fast, precise guards — the 30 WU arena above (out-of-arena
  // waypoints) and the pin test below (head exactly on its own border). This one
  // flies the whole fleet on the chance of catching a mechanism nobody has
  // thought of yet.
  //
  // It is short on purpose: the sim's cost per tick grows with territory
  // complexity, so a saturating arena gets superlinearly more expensive. At 800
  // ticks it cost 4.7 s here and 38.5 s on a shared CI runner, blowing a 30 s
  // timeout. Shortening it to 400 also cost it its teeth — at 400 ticks it no
  // longer catches the out-of-arena stall it originally found, which is exactly
  // why that mechanism got its own test rather than being left to this one.
  // Raise the tick count only with a fresh measurement of both.
  it(
    'every bot in a crowded small arena keeps playing — none of them stalls',
    { timeout: 60_000 },
    () => {
      // The regression that named this test: a head can end up ON its own border
      // AND against the arena edge at once. The way home is then "where you
      // already stand", the steer intent is 0, and the barrier holds the bot
      // there for the rest of its life — silently, because a pinned head lays no
      // new trail, so the exposure cap never fires either. Aggregates hide one
      // frozen bot in eight, so this asserts that EVERY bot closes loops.
      const state = createSimState(20260730, 60);
      const ids = [1, 2, 3, 4, 5, 6, 7, 8];
      step(state, { botJoins: ids }, TICK_DT_SEC);
      // Counted over the SECOND half only: the bot that used to freeze had
      // already painted twice before the barrier caught it, so "ever filled" was
      // green while it was parked against the wall.
      const { fills } = flyBots(state, 400, 200);
      for (const id of ids) {
        const player = state.players.find((p) => p.id === id);
        expect(
          fills.get(id),
          `bot ${String(id)} closed no loop in the last 10 s — parked at ` +
            `(${(player?.x ?? -1).toFixed(1)}, ${(player?.y ?? -1).toFixed(1)})`,
        ).toBeGreaterThan(0);
      }
    },
  );
});

/**
 * Standing EXACTLY on the own border, where that border is also the arena edge —
 * the state a returning head reaches when a fill left a ring vertex on the wall
 * and the barrier clamps the head onto it. "Aim at the nearest own border point"
 * is then "aim at yourself": no steer intent, and the barrier holds the head
 * there for good. It is silent, too — a pinned head lays no new trail, so
 * neither the exposure cap nor any aggregate notices.
 *
 * Reproduced exactly, because it is a float COINCIDENCE (distance 0, not 0.05):
 * land whose right edge is the arena edge, the head pinned onto it mid-return —
 * mid-return specifically, since that is when the pilot steers by re-entry
 * rather than by a waypoint. The warmups are the ticks at which the pilot is on
 * that leg; each of them parks forever if the inward fallback is removed.
 */
describe('never parked against the barrier (ticket 12 regression)', () => {
  it.each([81, 83, 85, 87, 89])('resumes painting after a pin at tick %i', (warmup) => {
    // The head starts inside this land, so the pilot's plan origin stays valid:
    // moving the head below must not read as a respawn, or it would replan and
    // steer by waypoint again — past the very path under test.
    const state = smallArenaWith(60, bot(1, 57, 12, 0, 57, 12));
    const pilot = new BotPilot(1);
    let fills = 0;
    const fly = (ticks: number, countFills: boolean): void => {
      for (let i = 0; i < ticks; i++) {
        const sight = senseFor(state, 1);
        const turns = sight ? [{ id: 1, turn: pilot.steer(sight) }] : [];
        const events = step(state, { turns }, TICK_DT_SEC);
        if (countFills) fills += events.fills.length;
      }
    };
    fly(warmup, false);
    const self = state.players.find((p) => p.id === 1);
    if (!self) throw new Error('the bot vanished');
    if (self.trail.length === 0) {
      throw new Error(`tick ${String(warmup)}: bot was home, not on its way back`);
    }
    // Pin: head exactly on its own border, which is exactly the wall, aimed
    // straight into it.
    self.x = 60;
    self.y = 12;
    self.heading = 0;
    fly(200, true);
    expect(
      fills,
      `never painted again — parked at (${self.x.toFixed(3)}, ${self.y.toFixed(3)})`,
    ).toBeGreaterThan(0);
  });
});

/** Path length of a trail polyline in WU (points compact, so counting them lies). */
function trailWU(trail: readonly Point[]): number {
  let total = 0;
  trail.forEach((point, i) => {
    const prev = trail[i - 1];
    if (prev) total += Math.hypot(point[0] - prev[0], point[1] - prev[1]);
  });
  return total;
}

/** Ticks a fleeing bot is given to turn around and cover the way back. */
const EVADE_WINDOW_TICKS = 40;

/**
 * One outbound run, optionally interrupted by a rival head appearing ahead of
 * the bot once it is 8 WU clear of home. Both variants share the pilot's
 * deterministic prefix and trigger at the SAME tick, so the window compared
 * afterwards is identical and the only difference in it is the threat.
 */
function outboundRun(withRival: boolean): { cameHomeInWindow: boolean; deaths: Death[] } {
  const state = stateWith(bot(1, 100, 100, 0));
  const pilot = new BotPilot(1);
  const deaths: Death[] = [];
  let triggerTick: number | null = null;
  let cameHomeInWindow = false;
  for (let tick = 0; tick < 200; tick++) {
    const self = state.players.find((p) => p.id === 1);
    if (!self) break;
    if (triggerTick === null && trailWU(self.trail) > 8) {
      triggerTick = tick;
      if (withRival) {
        // 10 WU straight ahead: inside the evade radius, far outside the 1 WU
        // head-on distance. It flies off sideways so it can never reach the
        // bot's trail — a threat to steer away from, not a killer.
        state.players.push(
          bot(
            2,
            self.x + Math.cos(self.heading) * 10,
            self.y + Math.sin(self.heading) * 10,
            self.heading + Math.PI / 2,
            20,
            20,
          ),
        );
      }
    }
    const sight = senseFor(state, 1);
    const turns = sight ? [{ id: 1, turn: pilot.steer(sight) }] : [];
    deaths.push(...step(state, { turns }, TICK_DT_SEC).deaths);
    const after = state.players.find((p) => p.id === 1);
    if (triggerTick !== null && tick <= triggerTick + EVADE_WINDOW_TICKS) {
      if (after?.trail.length === 0) cameHomeInWindow = true;
    }
  }
  return { cameHomeInWindow, deaths };
}

describe('evading (ticket 12: the heuristic plays the full loop, including away)', () => {
  it('a rival inside the evade radius aborts the excursion and sends the bot home', () => {
    const threatened = outboundRun(true);
    const alone = outboundRun(false);
    expect(threatened.deaths.filter((d) => d.victimId === 1)).toEqual([]);
    expect(threatened.cameHomeInWindow, 'the threatened bot broke off and closed its loop').toBe(
      true,
    );
    // Same window, same prefix, no threat: the excursion is still running —
    // otherwise "came home" would prove nothing about evading.
    expect(alone.cameHomeInWindow, 'the undisturbed bot was still outbound').toBe(false);
  });
});

describe('limited perception (ADR-0005: only what a human could see)', () => {
  it('hides heads beyond the sight radius and shows the ones inside it', () => {
    const pilot = bot(1, 100, 100, 0);
    const near = bot(2, 100 + BALANCE.bots.sightRadiusWU - 5, 100, Math.PI);
    const far = bot(3, 100 + BALANCE.bots.sightRadiusWU + 5, 100, Math.PI);
    const sight = senseFor(stateWith(pilot, near, far), 1);
    expect(sight?.threats).toEqual([[near.x, near.y]]);
  });
});
