import { describe, expect, it } from 'vitest';

import { SHARED_PACKAGE, sharedReady } from './index.js';

describe('shared stub', () => {
  it('exposes its package marker', () => {
    expect(SHARED_PACKAGE).toBe('shared');
  });

  it('reports ready', () => {
    expect(sharedReady()).toBe(true);
  });
});
