import { describe, expect, it } from 'vitest';

import { BALANCE, TICK_HZ } from './index.js';

describe('shared package surface', () => {
  it('re-exports balance + tick constants', () => {
    expect(BALANCE.arena.sizeWU).toBeGreaterThan(0);
    expect(TICK_HZ).toBeGreaterThan(0);
  });
});
