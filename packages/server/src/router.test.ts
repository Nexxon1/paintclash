import { describe, expect, it } from 'vitest';

import { handleFetch, healthPayload, type Env } from './router.js';

function fakeEnv(overrides: Partial<Env> = {}): Env & { forwarded: Request[] } {
  const forwarded: Request[] = [];
  return {
    ASSETS: {
      fetch: () => Promise.resolve(new Response('asset', { status: 200 })),
    },
    COMMIT_SHA: 'abc123',
    ARENA: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (request: Request) => {
          // Node cannot build a real 101 Response — the marker body suffices.
          forwarded.push(request);
          return Promise.resolve(new Response('upgraded'));
        },
      }),
      // Only the two methods the router touches are faked.
    } as unknown as Env['ARENA'],
    forwarded,
    ...overrides,
  };
}

describe('router worker (ADR-0004: stateless, routes WS to the arena DO)', () => {
  it('answers the health probe with the deployed commit', async () => {
    const env = fakeEnv();
    const response = await handleFetch(new Request('https://x/api/health'), env);
    expect(await response.json()).toEqual(healthPayload('abc123'));
  });

  it('forwards /ws to the one public arena DO', async () => {
    const env = fakeEnv();
    const response = await handleFetch(
      new Request('https://x/ws', { headers: { Upgrade: 'websocket' } }),
      env,
    );
    expect(await response.text()).toBe('upgraded');
    expect(env.forwarded).toHaveLength(1);
  });

  it('serves everything else from static assets', async () => {
    const env = fakeEnv();
    const response = await handleFetch(new Request('https://x/index.html'), env);
    expect(await response.text()).toBe('asset');
    expect(env.forwarded).toHaveLength(0);
  });
});
