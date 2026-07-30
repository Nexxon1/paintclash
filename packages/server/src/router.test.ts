import { BALANCE } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import {
  arenaSeedOverride,
  arenaSizeOverride,
  botTargetOverride,
  defaultBotTarget,
  handleFetch,
  healthPayload,
  type Env,
} from './router.js';

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

describe('dev-only env overrides', () => {
  it('takes a playable arena size and refuses anything else', () => {
    expect(arenaSizeOverride('50')).toBe(50);
    expect(arenaSizeOverride(undefined)).toBeUndefined();
    // An operator typo must fall back to the BALANCE default, never produce a
    // 1-WU or NaN-sized arena.
    for (const raw of ['', 'fifty', '9', '1001', 'NaN', 'Infinity', '-50']) {
      expect(arenaSizeOverride(raw)).toBeUndefined();
    }
  });

  it('takes a uint32 arena seed and refuses anything else', () => {
    // A pinned seed is what makes scenario spawns reproducible (§9.1) — so a
    // typo must degrade to "random", not to a seed of 0 by accident.
    expect(arenaSeedOverride('20260730')).toBe(20_260_730);
    expect(arenaSeedOverride('0')).toBe(0);
    expect(arenaSeedOverride(undefined)).toBeUndefined();
    for (const raw of ['', 'seed', '1.5', '-1', '4294967296', 'NaN', 'Infinity']) {
      expect(arenaSeedOverride(raw)).toBeUndefined();
    }
  });

  it('sizes the DEFAULT bot target to the arena, never above the balanced one', () => {
    // The spec's own room-sizing ladder (§10.4) read backwards: ~5000 WU² per
    // entity. The public arena lands on exactly the balanced target.
    expect(defaultBotTarget(BALANCE.arena.sizeWU)).toBe(BALANCE.bots.targetPopulation);
    expect(defaultBotTarget(100)).toBe(2); // the spec's 2-player map
    expect(defaultBotTarget(140)).toBe(3); // the spec's 4-player map
    // A map too small for even one entity's worth of room gets none. Eight bots
    // in a 50 WU arena is 16× the density the spec sizes for; it saturated and
    // blew the tick budget within 30 s of play.
    expect(defaultBotTarget(50)).toBe(0);
    // Never ABOVE the balanced target, however much room there is — the ceiling
    // is a gameplay decision, not an area one.
    expect(defaultBotTarget(1000)).toBe(BALANCE.bots.targetPopulation);
  });

  it('takes a bot target within the population rule and refuses anything else', () => {
    // 0 is a MEANING, not a typo: it switches the population off, which is how
    // the scenario choreographies stay hermetic.
    expect(botTargetOverride('0')).toBe(0);
    expect(botTargetOverride('4')).toBe(4);
    expect(botTargetOverride(undefined)).toBeUndefined();
    // Above the ceiling is a mis-set var, not a wish: falling back to the
    // BALANCE target is the only safe reading — an arena must never be flooded
    // by a stray environment variable.
    for (const raw of ['', ' ', 'eight', '2.5', '-1', 'NaN', 'Infinity', '999']) {
      expect(botTargetOverride(raw)).toBeUndefined();
    }
  });
});
