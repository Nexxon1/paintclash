import { SELF } from 'cloudflare:test';
import { BALANCE, type Point, type Territory, type TurnSignal } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 08, spec §2.5): the global leaderboard over the real wire —
 * a real Arena-DO in workerd, headless sim-clients on the real binary
 * protocol. Two properties matter and neither can be seen one seam down:
 *
 * 1. **Ranks follow the shares.** A player who fills overtakes one who does
 *    not — on EVERY client's board, not just their own.
 * 2. **The own rank survives the cut.** With more players than the board
 *    shows, whoever ranks below the top five still gets their own row.
 *
 * Both are checked against a ranking derived independently from the territory
 * syncs the same client received — the board must agree with the world the
 * client was told about, not merely with itself.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: () => string,
  timeoutMs = 25000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
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
    try {
      ws.send(frame);
    } catch {
      // The test tore this socket down while a queued frame was still
      // flushing. Uncaught, it lands in the DO's event loop as an unhandled
      // TypeError and buries the real failure in a wall of workerd stacks.
    }
  }, name);
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') client.receive(event.data);
  });
  client.join();
  return { client, ws };
}

interface Pose {
  x: number;
  y: number;
  heading: number;
}

/** Shortest arc from `from` to `to` in radians. */
function shortestArc(from: number, to: number): number {
  const TWO_PI = 2 * Math.PI;
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Bang-bang steering toward a target point, with a small deadband. */
function steerToward(self: Pose, target: Point): TurnSignal {
  const bearing = Math.atan2(target[1] - self.y, target[0] - self.x);
  const diff = shortestArc(self.heading, bearing);
  if (Math.abs(diff) < 0.06) return 0;
  return diff > 0 ? 1 : -1;
}

/** Centroid of a territory's first outer ring. */
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

/**
 * Park a client on its own land: bang-bang pursuit of the block centre
 * loiters at the turn radius (≈ 1.6 WU) inside a 6×6 block, so the head never
 * leaves its territory — no trail, no fill, a share that stands still (the
 * same station-keeping the rewind scenario relies on). Re-read every tick, so
 * a respawn simply moves the station.
 */
function park(client: SimClient, selfId: number): void {
  client.onSnapshot = (snapshot) => {
    const self = snapshot.players.find((p) => p.id === selfId);
    const home = client.territories.get(selfId);
    if (!self || !home || home.length === 0) return;
    client.queueTurn(steerToward(self, ringCenter(home)));
    client.flush();
  };
}

/** Waypoint autopilot; keeps steering toward the last waypoint (loiter). */
class Pilot {
  private waypoints: Point[] = [];
  private index = 0;

  constructor(private readonly arenaSizeWU: number) {}

  fly(waypoints: Point[]): void {
    this.waypoints = waypoints;
    this.index = 0;
  }

  steer(self: Pose): TurnSignal {
    let target = this.waypoints[this.index];
    while (target && this.index < this.waypoints.length - 1 && this.reached(self, target)) {
      this.index += 1;
      target = this.waypoints[this.index];
    }
    return target ? steerToward(self, target) : 0;
  }

  /** Reach-check against the waypoint clamped into the arena (wall-pinned). */
  private reached(self: Pose, target: Point): boolean {
    const cx = Math.min(this.arenaSizeWU, Math.max(0, target[0]));
    const cy = Math.min(this.arenaSizeWU, Math.max(0, target[1]));
    return Math.hypot(cx - self.x, cy - self.y) < 2;
  }
}

/**
 * The lobe run that grows a block (same shape the steal scenario uses to
 * make land worth stealing): a dogleg to align, out to the tip, a side gate
 * that forces the U-turn direction, a return corridor 4 WU beside the out
 * leg, then home from the side.
 */
function lobeWaypoints(center: Point, dir: Point): Point[] {
  const p: Point = [-dir[1], dir[0]];
  const tip: Point = [center[0] + dir[0] * 18, center[1] + dir[1] * 18];
  return [
    [center[0] - dir[0] * 3.5, center[1] - dir[1] * 3.5],
    tip,
    [tip[0] + p[0] * 4, tip[1] + p[1] * 4],
    [center[0] + p[0] * 4, center[1] + p[1] * 4],
    center,
  ];
}

/** Axis direction with the most room — the lobe tip needs U-turn space. */
function roomiestDirection(center: Point, arenaSizeWU: number): Point {
  const candidates: Point[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const room = (d: Point): number => {
    const tx = center[0] + d[0] * 22;
    const ty = center[1] + d[1] * 22;
    return Math.min(tx, ty, arenaSizeWU - tx, arenaSizeWU - ty);
  };
  return candidates.reduce((best, d) => (room(d) > room(best) ? d : best));
}

/** Share of the map the client's own territory sync implies, in percent. */
function derivedPercent(client: SimClient, id: number): number {
  const size = client.arenaSizeWU ?? BALANCE.arena.sizeWU;
  return (client.territoryAreaOf(id) / (size * size)) * 100;
}

/**
 * Ranking the client can derive on its own, from the territory syncs it got —
 * by the spec §2.5 rule (shown share first, ties by id), applied to a source
 * the board did not come from. Compared at the shown resolution: the wire
 * carries f32 coordinates, so the client's areas differ from the server's in
 * bits far below the second decimal.
 */
function derivedRanking(client: SimClient): number[] {
  const step = 10 ** BALANCE.leaderboard.percentDecimals;
  return [...client.territories.keys()]
    .map((id) => ({ id, shown: Math.round(derivedPercent(client, id) * step) }))
    .sort((a, b) => b.shown - a.shown || a.id - b.id)
    .map((entry) => entry.id);
}

describe('leaderboard over the real wire (ticket 08)', () => {
  it(
    'a fill lifts its owner past the parked player — on every client’s board',
    { timeout: 120_000 },
    async () => {
      // The sitter joins first, so the equal spawn blocks tie in ITS favour
      // (ties break by id) — the grower has to earn rank 1 with land.
      const sitter = await connect('Sitzer');
      const grower = await connect('Maler');
      try {
        await until(
          () => sitter.client.self(),
          () => 'sitter spawn',
        );
        await until(
          () => grower.client.self(),
          () => 'grower spawn',
        );
        const size = grower.client.arenaSizeWU ?? 0;
        const sitterId = sitter.client.playerId ?? -1;
        const growerId = grower.client.playerId ?? -1;
        park(sitter.client, sitterId);

        // Both park until the first board is in: the "before" picture must
        // not race the grower's first fill.
        const growerPilot = new Pilot(size);
        const growerHome = (): Point => ringCenter(grower.client.territories.get(growerId) ?? []);
        grower.client.onSnapshot = (snapshot) => {
          const self = snapshot.players.find((p) => p.id === growerId);
          if (!self) return;
          grower.client.queueTurn(growerPilot.steer(self));
          grower.client.flush();
        };
        await until(
          () => grower.client.territories.has(growerId) && grower.client.territories.has(sitterId),
          () => 'both start blocks synced',
        );
        growerPilot.fly([growerHome()]);

        const before = await until(
          () => (grower.client.leaderboard.length === 2 ? grower.client.leaderboard : null),
          () => 'the first board with both players',
        );
        expect(before.map((row) => row.playerId)).toEqual([sitterId, growerId]);
        expect(before.map((row) => row.rank)).toEqual([1, 2]);

        // Now grow. A failed lobe (self-cut) just respawns — fly it again.
        let deaths = grower.client.deaths.length;
        growerPilot.fly(lobeWaypoints(growerHome(), roomiestDirection(growerHome(), size)));
        await until(
          () => {
            if (grower.client.deaths.length > deaths) {
              deaths = grower.client.deaths.length;
              growerPilot.fly(lobeWaypoints(growerHome(), roomiestDirection(growerHome(), size)));
              return false;
            }
            return grower.client.territoryAreaOf(growerId) > 60;
          },
          () => `the lobe fill (area ${String(grower.client.territoryAreaOf(growerId))})`,
          90_000,
        );
        growerPilot.fly([growerHome()]); // park again: freeze the shares

        // Both boards must flip — the ranking is global, not per-viewer. The
        // board and the world view it is compared against are read in ONE
        // poll: a fill lands between two boards, and half a second of "the
        // map already knows, the board not yet" is correct behaviour, not a
        // failure.
        for (const { client, who } of [
          { client: grower.client, who: 'grower' },
          { client: sitter.client, who: 'sitter' },
        ]) {
          const board = await until(
            () => {
              const rows = client.leaderboard;
              if (rows.length !== 2) return null;
              const agrees = rows.every(
                (row) => Math.abs(row.areaPct - derivedPercent(client, row.playerId)) < 0.01,
              );
              return agrees && rows[0]?.playerId === growerId ? rows : null;
            },
            () => `${who} seeing the grower on top with the share it was synced`,
          );
          expect(board.map((row) => row.playerId)).toEqual(derivedRanking(client));
          expect(board.map((row) => row.rank)).toEqual([1, 2]);
          expect(board[0]?.areaPct ?? 0).toBeGreaterThan(board[1]?.areaPct ?? 0);
        }
        // Names ride along so the HUD can label the rows (spec §2.5).
        expect(grower.client.leaderboard.map((row) => row.name).sort()).toEqual([
          'Maler',
          'Sitzer',
        ]);
      } finally {
        sitter.ws.close();
        grower.ws.close();
      }
    },
  );

  it(
    'a player below the top five still gets their own row and true rank',
    { timeout: 120_000 },
    async () => {
      const crowd = BALANCE.leaderboard.topN + 2;
      const players: { client: SimClient; ws: WebSocket }[] = [];
      for (let i = 0; i < crowd; i++) players.push(await connect(`P${String(i + 1)}`));
      try {
        for (const player of players) {
          const self = await until(
            () => player.client.self(),
            () => 'spawn',
          );
          park(player.client, self.id);
        }
        await until(
          () => (players[0]?.client.snapshot?.players.length ?? 0) >= crowd,
          () => 'everyone spawned',
        );

        // Every client's board must match the ranking it can derive itself:
        // the shown rows are the global top N, cut at the recipient's own
        // row when that ranks below them.
        let trailing = 0;
        for (const player of players) {
          const id = player.client.playerId ?? -1;
          const board = await until(
            () => {
              const rows = player.client.leaderboard;
              if (rows.length === 0) return null;
              const ranking = derivedRanking(player.client);
              const ownRank = ranking.indexOf(id) + 1;
              const expected = ranking.slice(0, BALANCE.leaderboard.topN);
              if (ownRank > BALANCE.leaderboard.topN) expected.push(id);
              const same =
                rows.length === expected.length &&
                rows.every((row, i) => row.playerId === expected[i]);
              return same ? { rows, ownRank } : null;
            },
            () => `P${String(id)} seeing a board that matches its own world view`,
            60_000,
          );
          const own = board.rows.find((row) => row.playerId === id);
          expect(own?.rank).toBe(board.ownRank);
          if (board.ownRank > BALANCE.leaderboard.topN) {
            trailing += 1;
            // Top N + the appended own row — never a full ranking dump.
            expect(board.rows).toHaveLength(BALANCE.leaderboard.topN + 1);
            expect(board.rows[board.rows.length - 1]?.playerId).toBe(id);
          } else {
            expect(board.rows).toHaveLength(BALANCE.leaderboard.topN);
          }
        }
        // With two players more than the board shows, someone had to be cut.
        expect(trailing).toBe(crowd - BALANCE.leaderboard.topN);
      } finally {
        for (const player of players) player.ws.close();
      }
    },
  );
});
