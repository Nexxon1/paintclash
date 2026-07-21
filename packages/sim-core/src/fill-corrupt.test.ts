import type { Point, Territory } from '@paintclash/shared';
import { describe, expect, it, vi } from 'vitest';

import { closeLoop, spawnTerritory } from './fill.js';
import { squareRing } from './geometry.js';

// Own file: this mock RETURNS corrupt topology (a "hole" outside its outer
// ring — the verified pre-lattice failure shape) instead of throwing.
vi.mock('polyclip-ts', () => {
  const corrupt = (): Territory => [
    [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      // "Hole" entirely outside the outer ring — invalid even-odd topology.
      [
        [20, 20],
        [24, 20],
        [24, 24],
        [20, 24],
      ],
    ],
  ];
  return { union: corrupt, difference: corrupt };
});

describe('corrupt clipper output (topology guard)', () => {
  const trail: Point[] = [
    [7, 5],
    [12, 5],
    [12, 10],
    [7, 10],
    [7, 7],
  ];

  it('closeLoop refuses to store it — capture forfeited', () => {
    // Corrupt holes can only come out of the difference step (union output
    // is hole-filled anyway) — so a foreign territory must be in the field.
    const enemy: Territory = [[squareRing(20, 20, 4)]];
    expect(closeLoop([[squareRing(5, 5, 3)]], trail, [enemy])).toBeNull();
  });

  it('spawnTerritory falls back to the raw block', () => {
    const enemy: Territory = [[squareRing(2, 2, 3)]];
    expect(spawnTerritory(5, 5, 3, [enemy])).toEqual([[squareRing(5, 5, 3)]]);
  });
});
