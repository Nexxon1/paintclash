import { describe, expect, it } from 'vitest';

import { type Env, handleFetch, healthPayload } from './index.js';

function makeEnv(assetBody: string): Env {
  return {
    ASSETS: {
      fetch: (): Promise<Response> => Promise.resolve(new Response(assetBody)),
    },
  };
}

describe('server placeholder worker', () => {
  it('returns the health payload at /api/health', async () => {
    const res = await handleFetch(
      new Request('https://paintclash.example/api/health'),
      makeEnv('unused'),
    );
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual(healthPayload());
  });

  it('delegates every other path to the ASSETS binding', async () => {
    const res = await handleFetch(
      new Request('https://paintclash.example/'),
      makeEnv('index-html'),
    );
    const body = await res.text();
    expect(body).toBe('index-html');
  });
});
