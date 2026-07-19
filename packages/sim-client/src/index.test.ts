import { describe, expect, it } from 'vitest';

import { SIM_CLIENT_PACKAGE, simClientReady } from './index.js';

describe('sim-client stub', () => {
  it('exposes its package marker', () => {
    expect(SIM_CLIENT_PACKAGE).toBe('sim-client');
  });

  it('reports ready', () => {
    expect(simClientReady()).toBe(true);
  });
});
