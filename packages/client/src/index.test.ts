import { describe, expect, it } from 'vitest';

import { CLIENT_PACKAGE, clientReady } from './index.js';

describe('client stub', () => {
  it('exposes its package marker', () => {
    expect(CLIENT_PACKAGE).toBe('client');
  });

  it('reports ready', () => {
    expect(clientReady()).toBe(true);
  });
});
