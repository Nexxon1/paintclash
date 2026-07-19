import { describe, expect, it } from 'vitest';

import { createSimState, hashSimState, step } from './index.js';

describe('sim-core package surface', () => {
  it('exposes the create → step → hash pipeline', () => {
    const state = createSimState(1);
    step(state, { joins: [1] }, 0.05);
    expect(state.players).toHaveLength(1);
    expect(hashSimState(state)).toMatch(/^[0-9a-f]{8}$/);
  });
});
