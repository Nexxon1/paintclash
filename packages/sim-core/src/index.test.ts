import { describe, expect, it } from 'vitest';

import { SIM_CORE_PACKAGE, simCoreReady } from './index.js';

describe('sim-core stub', () => {
  it('exposes its package marker', () => {
    expect(SIM_CORE_PACKAGE).toBe('sim-core');
  });

  it('reports ready', () => {
    expect(simCoreReady()).toBe(true);
  });
});
