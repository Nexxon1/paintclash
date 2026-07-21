import { SELF } from 'cloudflare:test';
import { BALANCE, type Point, type Territory, type TurnSignal } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { closeLoop, pointInTerritory, territoryArea } from '@paintclash/sim-core';
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
      const aId = a.client.playerId ?? -1;
      const bId = b.client.playerId ?? -1;
      // Territory syncs carry the start blocks (ticket 04) — their centers
      // are the spawn spots, stable while both heads move on.
      const aBlock = await until(() => a.client.territories.get(aId), "alice's own territory");
      const bBlock = await until(() => a.client.territories.get(bId), "bob's territory at alice");
      const [ax, ay] = ringCenter(aBlock);
      const [bx, by] = ringCenter(bBlock);
      expect(Math.hypot(bx - ax, by - ay)).toBeGreaterThanOrEqual(
        BALANCE.spawn.minDistanceWU - 1e-3,
      );
    } finally {
      a.ws.close();
      b.ws.close();
    }

    function ringCenter(territory: Territory): Point {
      const ring = territory[0]?.[0] ?? [];
      let cx = 0;
      let cy = 0;
      for (const [x, y] of ring) {
        cx += x / ring.length;
        cy += y / ring.length;
      }
      return [cx, cy];
    }
  });

  it('a driven loop grows the territory by the enclosed area (ticket 04, spec §2.2)', async () => {
    const { client, ws } = await connect('painter');
    try {
      await until(() => client.self(), 'spawn snapshot');
      const id = client.playerId ?? -1;
      const spawnBlock = await until(() => client.territories.get(id), 'own territory sync');
      expect(territoryArea(spawnBlock)).toBeCloseTo(BALANCE.spawn.startBlockWU ** 2, 3);
      const before: Territory = structuredClone(spawnBlock);

      // Out-and-back: straight out, over-rotate past 180°, straight home —
      // paced one intent per authoritative tick like a real client.
      const plan: TurnSignal[] = [
        ...Array.from({ length: 12 }, (): TurnSignal => 0),
        ...Array.from({ length: 12 }, (): TurnSignal => 1),
        ...Array.from({ length: 60 }, (): TurnSignal => 0),
      ];
      let sent = 0;
      // Reconstruct the trail exactly like the sim does (last inside pose
      // seeds it, poses append while outside) — from the same snapshots the
      // server sends everyone.
      const trail: Point[] = [];
      let prev: Point | null = null;
      let filled = false;
      let closedTrail: Point[] | null = null;
      client.onTerritory = (update) => {
        if (update.playerId === id && update.reason === 'fill') filled = true;
      };
      client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === id);
        if (!self) return;
        const pose: Point = [self.x, self.y];
        if (filled && closedTrail === null && trail.length > 0) {
          // The fill's own tick: this pose is the loop-closing inside pose.
          closedTrail = [...trail, pose];
        }
        if (!filled) {
          if (pointInTerritory(self.x, self.y, before)) {
            trail.length = 0;
          } else {
            if (trail.length === 0 && prev) trail.push(prev);
            trail.push(pose);
          }
        }
        prev = pose;
        if (sent < plan.length) {
          client.queueTurn(plan[sent] ?? 0);
          client.flush();
          sent += 1;
        }
      };
      await until(() => (closedTrail ? true : null), 'the loop to close over the wire', 20000);
      client.onSnapshot = null;
      client.onTerritory = null;

      const after = await until(() => client.territories.get(id), 'grown territory');
      const gained = territoryArea(after) - territoryArea(before);
      // The trail actually left the block and the capture is real.
      expect(gained).toBeGreaterThanOrEqual(BALANCE.trail.minFillAreaWU2);
      // Cross-check the server's polygon fill against an independent local
      // reconstruction from wire poses (f32) — same rules, same result.
      const reconstructed = closeLoop(before, closedTrail ?? [], []);
      if (!reconstructed) throw new Error('local reconstruction captured nothing');
      expect(gained).toBeCloseTo(reconstructed.gainedArea, 1);
      // The trail is gone after the fill (spec §2.2: it ends with the loop).
      expect(client.trails.has(id)).toBe(false);
    } finally {
      ws.close();
    }
  });

  it('a short tap steers for exactly one authoritative tick — no jitter buffer, no lost input (ticket 17)', async () => {
    const { client, ws } = await connect('tapper');
    try {
      await until(() => client.self(), 'spawn snapshot');
      // One intent per server tick, paced by snapshot arrival: a snapshot
      // lands right after its tick ran, so each intent reaches the server
      // almost a full tick before the tick it is mapped to.
      const plan: TurnSignal[] = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      let sent = 0;
      const seen: { tick: number; ackSeq: number; turn: TurnSignal }[] = [];
      client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === client.playerId);
        if (!self) return;
        seen.push({ tick: snapshot.tick, ackSeq: snapshot.ackSeq, turn: self.turn });
        if (sent < plan.length) {
          client.queueTurn(plan[sent] ?? 0);
          client.flush();
          sent += 1;
        }
      };
      await until(
        () => (seen.length >= plan.length + 6 ? true : null),
        'the tap window to play out',
        15000,
      );
      client.onSnapshot = null;
      // The single-tick tap was applied for exactly one authoritative tick.
      expect(seen.filter((s) => s.turn === 1)).toHaveLength(1);
      // Tick-exact timeline, zero standing backlog: once anchored, the ack
      // trails the tick by a constant offset — including the dry ticks after
      // the plan ran out ("processed" ≠ "applied").
      const offsets = new Set(seen.slice(1).map((s) => s.tick - s.ackSeq));
      expect(offsets.size).toBe(1);
    } finally {
      ws.close();
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
