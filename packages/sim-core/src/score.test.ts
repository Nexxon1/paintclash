import { BALANCE, TICK_DT_SEC } from '@paintclash/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { squareRing, territoryArea } from './geometry.js';
import { mapSharePct } from './leaderboard.js';
import { seedRng } from './rng.js';
import { lifeScore, lifeStats } from './score.js';
import { createSimState, type PlayerSim, type SimState } from './state.js';
import { step } from './step.js';

/** A player with hand-set life counters — the score's whole input surface. */
function lived(counters: Partial<PlayerSim> = {}): PlayerSim {
  return {
    id: 1,
    x: 0,
    y: 0,
    heading: 0,
    turn: 0,
    territory: [[squareRing(50, 50, 3)]],
    trail: [],
    viewDelayTicks: 0,
    trailEpoch: 0,
    retiredTrails: [],
    history: [],
    isBot: false,
    lifeTicks: 0,
    peakPct: 0,
    otherHumanTicks: 0,
    ...counters,
  };
}

describe('lifeScore (spec §10.5 formula)', () => {
  /**
   * The spec's reference runs, quoted there rounded to three significant
   * digits (≈ 116 / 3 290 / 18 190). Pinned here at full precision: these
   * three numbers ARE the balance, so drifting off them must fail loudly.
   */
  it('reproduces the reference magnitudes of a quick death, a solid and a top run', () => {
    // 3 % held, 15 s, solo → 3 × √15 × 1 × 10.
    expect(lifeScore({ peakPct: 3, survivalSec: 15, avgOtherHumans: 0 })).toBe(116);
    // 15 %, 120 s, 4 other humans → 15 × √120 × 2 × 10 (spec: ≈ 3 290).
    expect(lifeScore({ peakPct: 15, survivalSec: 120, avgOtherHumans: 4 })).toBe(3286);
    // 35 %, 300 s, 8 other humans → 35 × √300 × 3 × 10 (spec: ≈ 18 190).
    expect(lifeScore({ peakPct: 35, survivalSec: 300, avgOtherHumans: 8 })).toBe(18187);
  });

  it('stays within a percent of the spec’s quoted magnitudes', () => {
    const quoted: [number, number][] = [
      [lifeScore({ peakPct: 3, survivalSec: 15, avgOtherHumans: 0 }), 116],
      [lifeScore({ peakPct: 15, survivalSec: 120, avgOtherHumans: 4 }), 3290],
      [lifeScore({ peakPct: 35, survivalSec: 300, avgOtherHumans: 8 }), 18190],
    ];
    for (const [actual, reference] of quoted) {
      expect(Math.abs(actual - reference) / reference).toBeLessThan(0.01);
    }
  });

  it('rewards survival sublinearly — four times the time is twice the score', () => {
    const short = lifeScore({ peakPct: 10, survivalSec: 30, avgOtherHumans: 0 });
    const long = lifeScore({ peakPct: 10, survivalSec: 120, avgOtherHumans: 0 });
    expect(long / short).toBeCloseTo(2, 2);
  });

  it('scales linearly with the peak share and with the company bonus', () => {
    const solo = lifeScore({ peakPct: 10, survivalSec: 100, avgOtherHumans: 0 });
    expect(lifeScore({ peakPct: 20, survivalSec: 100, avgOtherHumans: 0 })).toBe(2 * solo);
    // One other human = +25 %.
    expect(lifeScore({ peakPct: 10, survivalSec: 100, avgOtherHumans: 1 })).toBe(
      Math.round(solo * (1 + BALANCE.score.humanBonus)),
    );
  });

  it('is zero for a life that never held land or never lasted', () => {
    expect(lifeScore({ peakPct: 0, survivalSec: 300, avgOtherHumans: 8 })).toBe(0);
    expect(lifeScore({ peakPct: 35, survivalSec: 0, avgOtherHumans: 8 })).toBe(0);
  });

  it('never returns a negative or non-finite score, whatever it is fed', () => {
    // Nothing legitimate produces these — the guard exists because the
    // client feeds locally advanced numbers into the same function.
    expect(lifeScore({ peakPct: -5, survivalSec: 10, avgOtherHumans: 0 })).toBe(0);
    expect(lifeScore({ peakPct: 10, survivalSec: -10, avgOtherHumans: 0 })).toBe(0);
    expect(lifeScore({ peakPct: 10, survivalSec: 10, avgOtherHumans: -4 })).toBe(316);
    expect(lifeScore({ peakPct: NaN, survivalSec: 10, avgOtherHumans: 0 })).toBe(0);
    expect(lifeScore({ peakPct: Infinity, survivalSec: 10, avgOtherHumans: 0 })).toBe(0);
  });
});

describe('lifeStats (the ingredients as the sim accumulated them)', () => {
  it('averages the other-human integral over the ticks lived', () => {
    // 40 ticks = 2 s of life, 60 player-ticks of company → Ø 1.5 others.
    const stats = lifeStats(lived({ id: 7, lifeTicks: 40, peakPct: 12.5, otherHumanTicks: 60 }));
    expect(stats).toEqual({ playerId: 7, peakPct: 12.5, lifeTicks: 40, avgOtherHumans: 1.5 });
    expect(lifeScore({ ...stats, survivalSec: stats.lifeTicks * TICK_DT_SEC })).toBe(
      Math.round(12.5 * Math.sqrt(2) * (1 + 0.25 * 1.5) * 10),
    );
  });

  it('reports no company for a life that has not lived a tick yet', () => {
    // Guards the division: a player joining and leaving inside one tick.
    expect(lifeStats(lived()).avgOtherHumans).toBe(0);
  });
});

/** A player owning the (97..103)² block, head wherever it is put. */
function onBlock(id: number, x: number, y: number, heading: number): PlayerSim {
  return lived({ id, x, y, heading, territory: [[squareRing(100, 100, 3)]] });
}

function stateWith(...players: PlayerSim[]): SimState {
  return { tick: 0, rng: seedRng(1), arenaSizeWU: BALANCE.arena.sizeWU, players };
}

/** The 6×6 start block's share of the 200 WU arena — 36 / 40 000 = 0,09 %. */
const BLOCK_PCT = (BALANCE.spawn.startBlockWU ** 2 / BALANCE.arena.sizeWU ** 2) * 100;

describe('life counters over ticks (spec §10.5, ticket 09)', () => {
  it('starts a spawned life at zero ticks with the start block as its peak', () => {
    const state = createSimState(1);
    step(state, { joins: [1] }, TICK_DT_SEC);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    // One tick has been lived by the time the join's tick completes.
    expect(p.lifeTicks).toBe(1);
    expect(p.peakPct).toBeCloseTo(BLOCK_PCT, 10);
    expect(p.isBot).toBe(false);
  });

  it('counts one lived tick per step and integrates the other humans present', () => {
    const state = createSimState(2);
    step(state, { joins: [1] }, TICK_DT_SEC); // alone
    step(state, { joins: [2] }, TICK_DT_SEC); // from here on: one other human
    step(state, {}, TICK_DT_SEC);
    const [first, second] = state.players;
    if (!first || !second) throw new Error('players vanished');
    expect(first.lifeTicks).toBe(3);
    expect(second.lifeTicks).toBe(2);
    // Player 1 spent 1 tick alone and 2 with company → Ø 2/3 others.
    expect(lifeStats(first).avgOtherHumans).toBeCloseTo(2 / 3, 10);
    expect(lifeStats(second).avgOtherHumans).toBe(1);
  });

  it('never counts a bot as company — a bot-padded arena earns no multiplier', () => {
    const state = createSimState(3);
    step(state, { joins: [1], botJoins: [2, 3] }, TICK_DT_SEC);
    step(state, {}, TICK_DT_SEC);
    const [human, bot] = state.players;
    if (!human || !bot) throw new Error('players vanished');
    expect(human.isBot).toBe(false);
    expect(bot.isBot).toBe(true);
    // Three entities in the arena, still a solo score for the human.
    expect(state.players).toHaveLength(3);
    expect(lifeStats(human).avgOtherHumans).toBe(0);
    // …while the bots, spawned and steered like anyone (ADR-0005), do see
    // the human — their own (never reported) score is well-defined too.
    expect(lifeStats(bot).avgOtherHumans).toBe(1);
  });

  it('raises the peak when a fill grows the land, and keeps it when land is stolen', () => {
    // Loop from step.test.ts' fill recipe: block 36 WU² + 21 enclosed.
    const filler = onBlock(1, 102, 103.4, (3 * Math.PI) / 2);
    filler.trail = [
      [102, 100],
      [106, 100],
      [106, 106],
      [102, 106],
      [102, 103.4],
    ];
    const state = stateWith(filler);
    const events = step(state, {}, TICK_DT_SEC);
    expect(events.fills).toEqual([1]);
    const p = state.players[0];
    if (!p) throw new Error('player vanished');
    const grown = mapSharePct(p.territory, state.arenaSizeWU);
    expect(p.peakPct).toBeCloseTo(grown, 10);
    expect(grown).toBeGreaterThan(BLOCK_PCT);

    // Now shrink the land behind the sim's back (a steal does exactly this
    // to a victim): the PEAK is a high-water mark and must not fall with it.
    p.territory = [[squareRing(100, 100, 1)]];
    step(state, {}, TICK_DT_SEC);
    expect(territoryArea(p.territory)).toBeLessThan(36);
    expect(p.peakPct).toBeCloseTo(grown, 10);
  });

  it('closes the life on death — the stats ride out, then the counters reset', () => {
    // B's trail is the line x=100, y ∈ [92, 115.45]; A cuts it (death.test.ts).
    const victim = lived({
      id: 2,
      x: 100,
      y: 115,
      heading: Math.PI / 2,
      territory: [[squareRing(100, 90, 3)]],
      peakPct: 7.5,
      lifeTicks: 39,
      otherHumanTicks: 39,
    });
    victim.trail = [
      [100, 92],
      [100, 115],
    ];
    const killer = lived({
      id: 1,
      x: 99.1,
      y: 110,
      heading: 0,
      territory: [[squareRing(85, 110, 3)]],
    });
    const state = stateWith(killer, victim);
    const events = step(state, {}, TICK_DT_SEC);

    expect(events.deaths).toEqual([{ victimId: 2, killerId: 1, cause: 'trailCut' }]);
    // The tick they died in still counts as lived (40 ticks = 2 s), and the
    // peak is the one they actually held — not the neutralized zero.
    expect(events.endedLives).toEqual([
      { playerId: 2, peakPct: 7.5, lifeTicks: 40, avgOtherHumans: 1 },
    ]);
    const respawned = state.players.find((p) => p.id === 2);
    if (!respawned) throw new Error('victim vanished');
    // The next life starts from scratch, at its fresh block.
    expect(respawned.lifeTicks).toBe(0);
    expect(respawned.otherHumanTicks).toBe(0);
    expect(respawned.peakPct).toBeCloseTo(BLOCK_PCT, 10);
    // The killer's own life is untouched by someone else's death.
    expect(state.players.find((p) => p.id === 1)?.lifeTicks).toBe(1);
  });

  it('reports no ended lives on a quiet tick', () => {
    const state = createSimState(4);
    expect(step(state, { joins: [1] }, TICK_DT_SEC).endedLives).toEqual([]);
  });
});

describe('life-counter invariants under random play (spec §9.2, fast-check)', () => {
  const turnArb = fc.constantFrom<-1 | 0 | 1>(-1, 0, 1);

  it('the peak never falls within a life, and company never exceeds the humans present', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.record({ id: fc.integer({ min: 1, max: 4 }), turn: turnArb }), {
          minLength: 1,
          maxLength: 120,
        }),
        (seed, intents) => {
          const state = createSimState(seed);
          // Three humans and one bot, so both sides of the company rule are
          // under test at once.
          step(state, { joins: [1, 2, 3], botJoins: [4] }, TICK_DT_SEC);
          const peaks = new Map<number, number>();
          for (const intent of intents) {
            const events = step(state, { turns: [intent] }, TICK_DT_SEC);
            const died = new Set(events.endedLives.map((life) => life.playerId));
            for (const p of state.players) {
              const stats = lifeStats(p);
              // A life the sim just closed and respawned starts over — only
              // WITHIN one life is the peak a high-water mark.
              const previous = died.has(p.id) ? undefined : peaks.get(p.id);
              if (previous !== undefined) {
                expect(stats.peakPct).toBeGreaterThanOrEqual(previous - 1e-9);
              }
              peaks.set(p.id, stats.peakPct);
              // Never more company than there are other humans (3 humans in
              // this arena: a human sees ≤ 2, the bot ≤ 3), never negative.
              expect(stats.avgOtherHumans).toBeGreaterThanOrEqual(0);
              expect(stats.avgOtherHumans).toBeLessThanOrEqual(p.isBot ? 3 : 2);
              // The share held can never exceed the whole map.
              expect(stats.peakPct).toBeLessThanOrEqual(100 + 1e-9);
              expect(stats.lifeTicks).toBeGreaterThanOrEqual(0);
            }
            // Every closed life carries the counters of a life that was lived.
            for (const life of events.endedLives) {
              expect(life.lifeTicks).toBeGreaterThan(0);
              expect(life.peakPct).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
