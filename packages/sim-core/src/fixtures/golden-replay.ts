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

/** Scripted arena life: staggered joins, weaving turns, one leave. */
export function goldenScript(): Map<number, TickInputs> {
  const script = new Map<number, TickInputs>();
  script.set(0, { joins: [1] });
  script.set(10, { joins: [2] });
  script.set(20, { joins: [3], turns: [{ id: 1, turn: 1 }] });
  script.set(60, { turns: [{ id: 2, turn: -1 }] });
  script.set(90, {
    turns: [
      { id: 1, turn: 0 },
      { id: 3, turn: 1 },
    ],
  });
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

/** Expected `hashSimState` after GOLDEN_TICKS — pinned once, guarded forever. */
export const GOLDEN_END_HASH = '845f6194';
