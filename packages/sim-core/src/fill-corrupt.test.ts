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
    // It must also OVERLAP the capture: since ticket 22 a territory whose
    // bounding box cannot meet the capture is skipped without a clipper op,
    // and a skipped op produces no corrupt output to refuse. The mocked
    // union claims (0..10)², so the enemy is placed across it.
    const enemy: Territory = [[squareRing(8, 8, 3)]];
    expect(closeLoop([[squareRing(5, 5, 3)]], trail, [enemy])).toBeNull();
  });

  it('a far-away territory is never carved, so its corruption cannot forfeit the fill', () => {
    // The other side of the same premise, stated as behaviour: the forfeit
    // guards geometry the fill touches, not every territory on the map.
    const distant: Territory = [[squareRing(50, 50, 4)]];
    const outcome = closeLoop([[squareRing(5, 5, 3)]], trail, [distant]);
    expect(outcome).not.toBeNull();
    expect(outcome?.others[0]).toBe(distant);
  });

  it('spawnTerritory falls back to the raw block', () => {
    const enemy: Territory = [[squareRing(2, 2, 3)]];
    expect(spawnTerritory(5, 5, 3, [enemy])).toEqual([[squareRing(5, 5, 3)]]);
  });
});
