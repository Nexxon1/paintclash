import type { Point, Territory } from '@paintclash/shared';
import { describe, expect, it, vi } from 'vitest';

import { closeLoop, spawnTerritory } from './fill.js';
import { squareRing } from './geometry.js';

// Own file so the mock never leaks into the real-clipper fill tests.
vi.mock('polyclip-ts', () => ({
  union: (): never => {
    throw new Error('unable to complete output ring');
  },
  difference: (): never => {
    throw new Error('unable to complete output ring');
  },
}));

// The lattice removed every known natural trigger (spike-verified), but
// polyclip's failure modes are not provably empty — the tick must survive
// one deterministically.
describe('clipper failure', () => {
  it('closeLoop forfeits the capture instead of crashing the tick', () => {
    const territory: Territory = [[squareRing(5, 5, 3)]];
    const trail: Point[] = [
      [7, 5],
      [12, 5],
      [12, 10],
      [7, 10],
      [7, 7],
    ];
    expect(closeLoop(territory, trail, [])).toBeNull();
  });

  it('spawnTerritory falls back to the raw block — a live spawn wins', () => {
    const enemy: Territory = [[squareRing(2, 2, 3)]];
    expect(spawnTerritory(5, 5, 3, [enemy])).toEqual([[squareRing(5, 5, 3)]]);
  });
});
