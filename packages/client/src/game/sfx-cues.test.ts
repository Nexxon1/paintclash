import { describe, expect, it } from 'vitest';

import { RESPAWN_CUE_DELAY_MS, SfxCues } from './sfx-cues.js';

import type { RenderState } from './session.js';
import type { LeaderboardRow } from '@paintclash/protocol';
import type { Point, Territory } from '@paintclash/shared';

/** An axis-aligned square territory around (cx, cy). */
function block(cx: number, cy: number, size = 10): Territory {
  const h = size / 2;
  return [
    [
      [
        [cx - h, cy - h],
        [cx + h, cy - h],
        [cx + h, cy + h],
        [cx - h, cy + h],
      ],
    ],
  ];
}

/** One rendered frame; everything not named is empty/absent. */
function frame(patch: Partial<RenderState> = {}): RenderState {
  return {
    self: null,
    selfId: 1,
    others: [],
    arenaSizeWU: 100,
    territories: [],
    trails: [],
    fills: [],
    deaths: [],
    leaderboard: { rev: 0, rows: [] },
    liveScore: null,
    finishedLife: null,
    ...patch,
  };
}

/** A frame where the own head is alive at (x, y). */
function alive(x: number, y: number, patch: Partial<RenderState> = {}): RenderState {
  return frame({ self: { x, y, heading: 0 }, ...patch });
}

function board(rev: number, ranks: [rank: number, playerId: number][]): RenderState['leaderboard'] {
  return {
    rev,
    rows: ranks.map(([rank, playerId]): LeaderboardRow => ({
      rank,
      playerId,
      areaPct: 1,
      name: 'x',
    })),
  };
}

/** Play `n` frames of nothing at 16 ms and collect every cue they emit. */
function idle(cues: SfxCues, n: number, state = alive(0, 0)): string[] {
  const seen: string[] = [];
  for (let i = 0; i < n; i++) seen.push(...cues.sample(state, 16).cues);
  return seen;
}

describe('own life cues (spec §4.4: strictly egocentric)', () => {
  it('greets the first own pose with the join cue, exactly once', () => {
    const cues = new SfxCues();
    // Before the spawn there is nothing to sound: no pose, no cue.
    expect([...cues.sample(frame(), 16).cues]).toEqual([]);
    expect([...cues.sample(alive(0, 0), 16).cues]).toEqual(['spawn']);
    expect(idle(cues, 5)).toEqual([]);
  });

  it('sounds the own fill and ignores every foreign one', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    expect([...cues.sample(alive(0, 0, { fills: [2, 3] }), 16).cues]).toEqual([]);
    expect([...cues.sample(alive(0, 0, { fills: [2, 1] }), 16).cues]).toEqual(['fill']);
  });

  it('sounds an own kill, and only when the own head survived it', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    const cut = { victimId: 2, killerId: 1, cause: 'trailCut' as const };
    expect([...cues.sample(alive(0, 0, { deaths: [cut] }), 16).cues]).toEqual(['kill']);
    // A foreign death the local player had no hand in stays silent.
    expect([
      ...cues.sample(alive(0, 0, { deaths: [{ victimId: 2, killerId: 3, cause: 'trailCut' }] }), 16)
        .cues,
    ]).toEqual([]);
    // A self-cut names the victim as their own killer (sim-core) — that is a
    // death, never a kill.
    expect([
      ...cues.sample(alive(0, 0, { deaths: [{ victimId: 1, killerId: 1, cause: 'trailCut' }] }), 16)
        .cues,
    ]).toEqual(['death']);
  });

  it('does not call a head-on that killed both of us a won duel', () => {
    // spec §4.4 sounds a kill for a head-on WON; both dying is not winning.
    const cues = new SfxCues();
    idle(cues, 1);
    const both = cues.sample(
      alive(0, 0, {
        deaths: [
          { victimId: 2, killerId: 1, cause: 'headOn' },
          { victimId: 1, killerId: 2, cause: 'headOn' },
        ],
      }),
      16,
    );
    expect([...both.cues]).toEqual(['death']);
  });

  it('still credits a kill that has nothing to do with the own death', () => {
    // Cut player 2's trail in the very frame player 3 cuts ours: two separate
    // events, and dying does not un-cut the trail we cut.
    const cues = new SfxCues();
    idle(cues, 1);
    const both = cues.sample(
      alive(0, 0, {
        deaths: [
          { victimId: 2, killerId: 1, cause: 'trailCut' },
          { victimId: 1, killerId: 3, cause: 'trailCut' },
        ],
      }),
      16,
    );
    expect([...both.cues]).toEqual(['death', 'kill']);
    // A head-on won against ONE opponent while a THIRD player kills us is
    // still a won duel against that opponent.
    const cues2 = new SfxCues();
    idle(cues2, 1);
    expect([
      ...cues2.sample(
        alive(0, 0, {
          deaths: [
            { victimId: 2, killerId: 1, cause: 'headOn' },
            { victimId: 1, killerId: 3, cause: 'trailCut' },
          ],
        }),
        16,
      ).cues,
    ]).toEqual(['death', 'kill']);
  });

  it('does not sound a kill for painting away the last of someone’s land', () => {
    // Total loss names the FILLER as killer (sim-core `step.ts`), but spec §4.4
    // lists Totalverlust under the own-death cue, not under Kill — and the fill
    // that caused it is already sounding its own reward.
    const cues = new SfxCues();
    idle(cues, 1);
    const wipe = cues.sample(
      alive(0, 0, {
        fills: [1],
        deaths: [{ victimId: 2, killerId: 1, cause: 'totalLoss' }],
      }),
      16,
    );
    expect([...wipe.cues]).toEqual(['fill']);
  });

  it('still rewards a fill that lands in the frame the own life ends', () => {
    // Rare (a loop closes as a head-on lands), but the fill was earned.
    const cues = new SfxCues();
    idle(cues, 1);
    const both = cues.sample(
      alive(0, 0, {
        fills: [1],
        deaths: [{ victimId: 1, killerId: 2, cause: 'headOn' }],
      }),
      16,
    );
    expect([...both.cues]).toEqual(['death', 'fill']);
  });

  it('sounds one kill per frame, however many enemies fell', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    const double = cues.sample(
      alive(0, 0, {
        deaths: [
          { victimId: 2, killerId: 1, cause: 'trailCut' },
          { victimId: 3, killerId: 1, cause: 'trailCut' },
        ],
      }),
      16,
    );
    expect([...double.cues]).toEqual(['kill']);
  });

  it('answers the own death with the respawn cue, a beat later', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    const death = alive(0, 0, { deaths: [{ victimId: 1, killerId: 2, cause: 'totalLoss' }] });
    expect([...cues.sample(death, 16).cues]).toEqual(['death']);
    // The server respawns in the same tick as the death (arena.ts sends the
    // death frame, then the fresh territory) — the two cues would collide, so
    // the "you are back" one waits out the death sound.
    expect(idle(cues, 1)).toEqual([]);
    expect(idle(cues, Math.ceil(RESPAWN_CUE_DELAY_MS / 16))).toEqual(['spawn']);
    // And once only.
    expect(idle(cues, 40)).toEqual([]);
  });

  it('holds the beat even when the first drawn frame is already a death', () => {
    const cues = new SfxCues();
    const death = alive(0, 0, { deaths: [{ victimId: 1, killerId: 2, cause: 'headOn' }] });
    // Join and death in one frame: the death sounds, and the cue for the new
    // life waits out the same beat rather than doubling with it.
    expect([...cues.sample(death, 16).cues]).toEqual(['death']);
    expect(idle(cues, 1)).toEqual([]);
    expect(idle(cues, Math.ceil(RESPAWN_CUE_DELAY_MS / 16))).toEqual(['spawn']);
  });

  it('never stacks two respawn cues when a second death lands first', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    const death = alive(0, 0, { deaths: [{ victimId: 1, killerId: 2, cause: 'trailCut' }] });
    expect([...cues.sample(death, 16).cues]).toEqual(['death']);
    // Died again while the first respawn cue was still pending.
    expect([...cues.sample(death, 16).cues]).toEqual(['death']);
    expect(idle(cues, Math.ceil(RESPAWN_CUE_DELAY_MS / 16) + 40)).toEqual(['spawn']);
  });
});

describe('rank cue (spec §4.4: Leaderboard-Überholen)', () => {
  it('sounds when the own rank improves, not when it drops or holds', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    // The first board is only a baseline — arriving on the board is not a climb.
    expect([...cues.sample(alive(0, 0, { leaderboard: board(1, [[4, 1]]) }), 16).cues]).toEqual([]);
    expect([...cues.sample(alive(0, 0, { leaderboard: board(2, [[2, 1]]) }), 16).cues]).toEqual([
      'rankup',
    ]);
    // Same board again (rev unchanged, then unchanged rank): silence.
    expect(idle(cues, 3, alive(0, 0, { leaderboard: board(2, [[2, 1]]) }))).toEqual([]);
    expect([...cues.sample(alive(0, 0, { leaderboard: board(3, [[2, 1]]) }), 16).cues]).toEqual([]);
    // Overtaken again — a drop is silent, and the next climb sounds from there.
    expect([...cues.sample(alive(0, 0, { leaderboard: board(4, [[5, 1]]) }), 16).cues]).toEqual([]);
    expect([...cues.sample(alive(0, 0, { leaderboard: board(5, [[4, 1]]) }), 16).cues]).toEqual([
      'rankup',
    ]);
  });

  it('ignores a board the own row is missing from', () => {
    const cues = new SfxCues();
    idle(cues, 1);
    cues.sample(alive(0, 0, { leaderboard: board(1, [[3, 1]]) }), 16);
    // Top-5-only board (the own row rides along in practice, but a board
    // without it must not read as "rank 1").
    expect([...cues.sample(alive(0, 0, { leaderboard: board(2, [[1, 7]]) }), 16).cues]).toEqual([]);
    expect([...cues.sample(alive(0, 0, { leaderboard: board(3, [[3, 1]]) }), 16).cues]).toEqual([]);
  });
});

describe('the eat loop (spec §4.4: only over FOREIGN ground)', () => {
  const ownLand = { playerId: 1, territory: block(0, 0), rev: 1 };
  const enemyLand = { playerId: 2, territory: block(30, 0), rev: 1 };
  const trail = (points: Point[]) => [{ playerId: 1, points }];
  const eating = trail([
    [10, 0],
    [30, 0],
  ]);

  it('plays while the own trail eats through enemy land', () => {
    const cues = new SfxCues();
    const state = alive(30, 0, {
      territories: [ownLand, enemyLand],
      trails: eating,
    });
    idle(cues, 1, state);
    expect(cues.sample(state, 16).eating).toBe(true);
  });

  it('stays silent over neutral ground and inside the own land', () => {
    const cues = new SfxCues();
    // Out on neutral ground with a trail: that is not eating anything.
    expect(
      cues.sample(
        alive(18, 0, {
          territories: [ownLand, enemyLand],
          trails: trail([
            [10, 0],
            [18, 0],
          ]),
        }),
        16,
      ).eating,
    ).toBe(false);
    // Home ground is safespace — no trail exists there at all.
    expect(
      cues.sample(alive(0, 0, { territories: [ownLand, enemyLand], trails: [] }), 16).eating,
    ).toBe(false);
  });

  it('stops the moment the own life ends, before any respawn', () => {
    const cues = new SfxCues();
    const state = alive(30, 0, { territories: [ownLand, enemyLand], trails: eating });
    idle(cues, 1, state);
    expect(cues.sample(state, 16).eating).toBe(true);
    const killed = alive(30, 0, {
      territories: [ownLand, enemyLand],
      trails: eating,
      deaths: [{ victimId: 1, killerId: 2, cause: 'trailCut' }],
    });
    expect(cues.sample(killed, 16).eating).toBe(false);
  });

  it('needs a trail: a head crossing enemy land without one is not eating', () => {
    // Cannot happen in the sim (outside your own land you always trail), but
    // the loop must hang off the TRAIL the spec names, not off the position.
    const cues = new SfxCues();
    const state = alive(30, 0, { territories: [ownLand, enemyLand], trails: [] });
    idle(cues, 1, state);
    expect(cues.sample(state, 16).eating).toBe(false);
  });

  it('says nothing at all before the own id is known', () => {
    const cues = new SfxCues();
    const state = frame({
      selfId: null,
      self: { x: 30, y: 0, heading: 0 },
      territories: [ownLand, enemyLand],
      trails: eating,
      fills: [1],
      deaths: [{ victimId: 1, killerId: 2, cause: 'trailCut' }],
    });
    const sample = cues.sample(state, 16);
    expect([...sample.cues]).toEqual([]);
    expect(sample.eating).toBe(false);
  });
});

describe('cost per frame', () => {
  it('reuses one cue buffer instead of allocating per frame (spec §4.4)', () => {
    const cues = new SfxCues();
    const first = cues.sample(alive(0, 0), 16);
    const second = cues.sample(alive(0, 0, { fills: [1] }), 16);
    expect(second).toBe(first);
    expect(second.cues).toBe(first.cues);
    // Reused means the PREVIOUS frame's cues are gone, not appended to.
    expect([...second.cues]).toEqual(['fill']);
  });
});
