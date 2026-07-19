import { describe, expect, it } from 'vitest';

import { PROTOCOL_PACKAGE, protocolReady } from './index.js';

describe('protocol stub', () => {
  it('exposes its package marker', () => {
    expect(PROTOCOL_PACKAGE).toBe('protocol');
  });

  it('reports ready', () => {
    expect(protocolReady()).toBe(true);
  });
});
