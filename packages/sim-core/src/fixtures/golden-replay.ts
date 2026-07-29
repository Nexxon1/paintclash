/**
 * Golden replay fixture (spec §9.2): a checked-in input log plus the expected
 * end hash. If any future change makes this replay produce a different hash,
 * the determinism contract (or the sim's semantics) changed — either is a
 * deliberate decision, never an accident. Regenerate the hash only on an
 * intentional semantics change and say so in the commit.
 */

import type { TickInputs } from '../step.js';

export const GOLDEN_SEED = 0xc0ffee;
export const GOLDEN_TICKS = 400;

/**
 * Scripted arena life: staggered joins, weaving turns, one leave — and a
 * deliberate out-and-back maneuver for player 1 (straight out, half turn,
 * straight back) so the replay provably crosses the trail → loop → fill
 * path (asserted in replay.test.ts, ticket 04). Since ticket 05 the held
 * turns later in the script matter too: a sustained max-rate turn outside
 * the own land circles into the own trail — the replay provably crosses
 * the death → respawn path as well. The fill runs FIRST (ticks 12–40), so
 * no death can steal it.
 */
export function goldenScript(): Map<number, TickInputs> {
  const script = new Map<number, TickInputs>();
  script.set(0, { joins: [1] });
  script.set(10, { joins: [2] });
  // Player 1 out-and-back: 12 straight ticks leave the block for sure
  // (5.4 WU > half diagonal 4.24), ~11 turning ticks flip the heading
  // (16°/tick), then straight retraces a parallel track 3.2 WU beside the
  // outbound one — back across the 6-WU-wide block.
  script.set(12, { turns: [{ id: 1, turn: 1 }] });
  script.set(20, { joins: [3] });
  script.set(23, { turns: [{ id: 1, turn: 0 }] });
  // Ticket 07: standing view delays put the rewind machinery (history
  // windows, trail retirement, rewound judgment) on the golden path — the
  // far-apart players make it observationally idle, but any determinism
  // leak in it would move the hash.
  script.set(30, {
    views: [
      { id: 1, viewDelayTicks: 3 },
      { id: 2, viewDelayTicks: 7 },
    ],
  });
  // Ticket 09: a bot in the arena puts the life counters' human/bot
  // accounting on the golden path — it spawns and steers like anyone, so any
  // determinism leak in the score bookkeeping moves the hash. Joins after
  // player 1's fill (ticks 12–35) so it cannot disturb it.
  script.set(40, { botJoins: [9] });
  script.set(60, { turns: [{ id: 2, turn: -1 }] });
  script.set(90, { turns: [{ id: 3, turn: 1 }] });
  script.set(150, { leaves: [2] });
  script.set(151, { joins: [4] });
  script.set(200, {
    turns: [
      { id: 3, turn: -1 },
      { id: 4, turn: 1 },
    ],
  });
  script.set(300, { turns: [{ id: 1, turn: -1 }] });
  return script;
}

/**
 * Expected `hashSimState` after GOLDEN_TICKS — pinned once, guarded forever.
 * Regenerated for ticket 09 (the score entered the state: bot flag and the
 * per-life counters are hashed now, and the script gained the bot join
 * above): a deliberate semantics change, not drift.
 * Previous: '9ebfdacf' (ticket 07), '82bff39b' (ticket 05), '779967a5' (04).
 */
export const GOLDEN_END_HASH = 'a1106a61';
