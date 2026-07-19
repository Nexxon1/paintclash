import { SELF } from 'cloudflare:test';
import { BALANCE } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (spec §9.1): a real Arena-DO in workerd, driven by headless
 * sim-clients over the real WebSocket + binary protocol. This is the
 * regression guard for "a player moves end-to-end".
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined,
  what: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function connect(name: string): Promise<{ client: SimClient; ws: WebSocket }> {
  const response = await SELF.fetch('https://arena/ws', {
    headers: { Upgrade: 'websocket' },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error('server did not upgrade the connection');
  ws.accept();
  const client = new SimClient((frame) => {
    ws.send(frame);
  }, name);
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') client.receive(event.data);
  });
  client.join();
  return { client, ws };
}

describe('walking skeleton over the real wire', () => {
  it('joins, gets welcomed, and appears in server snapshots', async () => {
    const { client, ws } = await connect('kopf');
    try {
      await until(() => client.playerId, 'welcome');
      expect(client.arenaSizeWU).toBe(BALANCE.arena.sizeWU);
      const self = await until(() => client.self(), 'first snapshot containing self');
      expect(self.x).toBeGreaterThanOrEqual(0);
      expect(self.x).toBeLessThanOrEqual(BALANCE.arena.sizeWU);
    } finally {
      ws.close();
    }
  });

  it('moves the head at constant speed between snapshots', async () => {
    const { client, ws } = await connect('runner');
    try {
      const first = await until(() => client.self(), 'spawn snapshot');
      const firstTick = client.snapshot?.tick ?? 0;
      const later = await until(() => {
        const s = client.self();
        return client.snapshot && client.snapshot.tick >= firstTick + 10 ? s : null;
      }, 'ten ticks of movement');
      const ticks = (client.snapshot?.tick ?? 0) - firstTick;
      const dist = Math.hypot(later.x - first.x, later.y - first.y);
      // Straight line at 0.45 WU/tick (walls can shorten the crow-flies path).
      expect(dist).toBeGreaterThan(0);
      expect(dist).toBeLessThanOrEqual(ticks * 0.45 + 0.01);
    } finally {
      ws.close();
    }
  });

  it('a steer intent turns the authoritative heading', async () => {
    const { client, ws } = await connect('turner');
    try {
      await until(() => client.self(), 'spawn snapshot');
      const before = client.self();
      if (!before) throw new Error('no self');
      client.queueTurn(1);
      client.flush();
      const startTick = client.snapshot?.tick ?? 0;
      await until(
        () => (client.snapshot && client.snapshot.tick >= startTick + 4 ? client.self() : null),
        'intent to take effect',
      );
      const after = client.self();
      // The server echoes the applied turn and the heading moved.
      expect(after?.turn).toBe(1);
      expect(after?.heading).not.toBeCloseTo(before.heading, 3);
    } finally {
      ws.close();
    }
  });

  it('two sim-clients see each other and spawn ≥ 25 WU apart', async () => {
    const a = await connect('alice');
    const b = await connect('bob');
    try {
      await until(() => a.client.self(), 'alice spawn');
      await until(() => b.client.self(), 'bob spawn');
      const bId = b.client.playerId;
      const bothSeen = await until(
        () => a.client.snapshot?.players.find((p) => p.id === bId),
        'alice seeing bob',
      );
      const aSelf = a.client.self();
      if (!aSelf) throw new Error('alice lost herself');
      // Spawn min distance (spec §2.3) held across the wire (f32 tolerance;
      // both heads have moved a little since spawning).
      const dist = Math.hypot(bothSeen.blockCx - aSelf.blockCx, bothSeen.blockCy - aSelf.blockCy);
      expect(dist).toBeGreaterThanOrEqual(BALANCE.spawn.minDistanceWU - 1);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it("a disconnected player disappears from the other client's snapshots", async () => {
    const a = await connect('stays');
    const b = await connect('leaves');
    try {
      await until(() => a.client.self(), 'a spawn');
      await until(() => b.client.self(), 'b spawn');
      const bId = b.client.playerId;
      await until(() => a.client.snapshot?.players.find((p) => p.id === bId), 'a seeing b');
      b.ws.close();
      await until(
        () =>
          a.client.snapshot && !a.client.snapshot.players.some((p) => p.id === bId) ? true : null,
        'b to vanish from snapshots',
      );
    } finally {
      a.ws.close();
    }
  });
});
