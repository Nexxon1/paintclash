import { SELF } from 'cloudflare:test';
import type { Point, Territory, TurnSignal } from '@paintclash/shared';
import { SimClient } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/**
 * Scenario (ticket 06, spec §2.2): real Arena-DO in workerd, two headless
 * sim-clients over the real wire. Spawns are random, so everything steers by
 * feedback. The choreography below is fuzz-validated against sim-core
 * (500/500 seeds at 0–3 ticks of feedback lag — see the ticket): a "thief"
 * rings a parked "mark" and closes the loop at home, stealing everything
 * the ring encloses; every death that is not the expected outcome triggers
 * a replan from the fresh respawn state instead of failing the test.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: string,
  timeoutMs = 60000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
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

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bounds(territory: Territory): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const poly of territory) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        b.minX = Math.min(b.minX, x);
        b.minY = Math.min(b.minY, y);
        b.maxX = Math.max(b.maxX, x);
        b.maxY = Math.max(b.maxY, y);
      }
    }
  }
  return b;
}

function centerOf(b: Bounds): Point {
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/**
 * Park spot for a block owner: the center, nudged off any nearby wall. A
 * block flush against a wall leaves < 1 WU between wall and block edge — a
 * raider sliding along that wall would meet the parked head within the
 * head-on radius. Nudging keeps the loiter orbit clear of the squeeze.
 */
function parkSpot(center: Point, arenaSizeWU: number): Point {
  const nudge = (v: number): number => {
    if (v < 6) return v + 1.5;
    if (v > arenaSizeWU - 6) return v - 1.5;
    return v;
  };
  return [nudge(center[0]), nudge(center[1])];
}

/** Corner ring whose first and last corners flank the side facing `home`. */
function ringAround(b: Bounds, home: Point, margin: number): Point[] {
  const sw: Point = [b.minX - margin, b.minY - margin];
  const se: Point = [b.maxX + margin, b.minY - margin];
  const ne: Point = [b.maxX + margin, b.maxY + margin];
  const nw: Point = [b.minX - margin, b.maxY + margin];
  const [cx, cy] = centerOf(b);
  const dx = home[0] - cx;
  const dy = home[1] - cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx < 0 ? [sw, se, ne, nw] : [ne, nw, sw, se];
  }
  return dy < 0 ? [se, ne, nw, sw] : [nw, sw, se, ne];
}

/**
 * The thief's raid path: dogleg align behind home (a drive back through the
 * own block re-enters territory, which resets the messy random-heading exit
 * arc), the four ring corners, then home via a corridor offset 12 WU to the
 * last corner's side — a far-away mark makes exit and direct return nearly
 * parallel, and steering wobble would cross them; the corridor keeps the
 * return clear and enters the home block from a perpendicular side.
 */
function raidWaypoints(home: Point, target: Bounds, margin: number): Point[] {
  const ring = ringAround(target, home, margin);
  const c1 = ring[0] ?? home;
  const c4 = ring[ring.length - 1] ?? home;
  const px = c4[0] - c1[0];
  const py = c4[1] - c1[1];
  const plen = Math.hypot(px, py) || 1;
  const p: Point = [(px / plen) * 12, (py / plen) * 12];
  const ax = home[0] - c1[0];
  const ay = home[1] - c1[1];
  const alen = Math.hypot(ax, ay) || 1;
  const align: Point = [home[0] + (ax / alen) * 3.5, home[1] + (ay / alen) * 3.5];
  return [align, ...ring, [c4[0] + p[0], c4[1] + p[1]], [home[0] + p[0], home[1] + p[1]], home];
}

/**
 * The mark's lobe path: align dogleg, out to the tip, a side gate forcing
 * the U-turn direction, a parallel return corridor 4 WU beside the out leg,
 * then home from the side.
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

/**
 * Direction for the mark's lobe: land that must SURVIVE the later raid, so
 * it points away from the raid's enclosure — anti-home first, else a
 * perpendicular — and away from walls (the tip needs U-turn room).
 */
function lobeDirection(center: Point, home: Point, arenaSizeWU: number): Point {
  const ux = home[0] - center[0];
  const uy = home[1] - center[1];
  const ulen = Math.hypot(ux, uy) || 1;
  const u: Point = [ux / ulen, uy / ulen];
  const candidates: Point[] = [
    [-u[0], -u[1]],
    [-u[1], u[0]],
    [u[1], -u[0]],
  ];
  const room = (d: Point): number => {
    const tx = center[0] + d[0] * 22;
    const ty = center[1] + d[1] * 22;
    return Math.min(tx, ty, arenaSizeWU - tx, arenaSizeWU - ty);
  };
  let best = candidates[0] ?? u;
  for (const d of candidates) {
    if (room(d) >= 5) return d;
    if (room(d) > room(best)) best = d;
  }
  return best;
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

  /**
   * Reach-check against the waypoint CLAMPED into the arena: a corner laid
   * beyond a wall keeps the head pressed against it (steering at the raw
   * point) but still counts as reached once the along-wall part aligns.
   */
  private reached(self: Pose, target: Point): boolean {
    const cx = Math.min(this.arenaSizeWU, Math.max(0, target[0]));
    const cy = Math.min(this.arenaSizeWU, Math.max(0, target[1]));
    return Math.hypot(cx - self.x, cy - self.y) < 2;
  }
}

/** Deaths of one victim seen by a client so far. */
function deathsOf(client: SimClient, victimId: number): number {
  return client.deaths.filter((d) => d.victimId === victimId).length;
}

/** Wire a pilot to a client: one steer intent per snapshot, like a player. */
function autopilot(client: SimClient, selfId: number, arenaSizeWU: number): Pilot {
  const pilot = new Pilot(arenaSizeWU);
  client.onSnapshot = (snapshot) => {
    const self = snapshot.players.find((p) => p.id === selfId);
    if (!self) return;
    client.queueTurn(pilot.steer(self));
    client.flush();
  };
  return pilot;
}

describe('stealing over the real wire (ticket 06)', () => {
  it(
    'painting a parked player away entirely is a total-loss death — head on own land throughout',
    { timeout: 180_000 },
    async () => {
      const thief = await connect('thief');
      const mark = await connect('mark');
      try {
        await until(() => thief.client.self(), 'thief spawn');
        await until(() => mark.client.self(), 'mark spawn');
        const size = thief.client.arenaSizeWU ?? 0;
        const thiefId = thief.client.playerId ?? -1;
        const markId = mark.client.playerId ?? -1;
        const markPilot = autopilot(mark.client, markId, size);
        const thiefPilot = autopilot(thief.client, thiefId, size);
        const replan = (): void => {
          const markT = thief.client.territories.get(markId);
          const thiefT = thief.client.territories.get(thiefId);
          if (!markT || !thiefT) return;
          const markHome = bounds(markT);
          // The mark never leaves its block — its head sits on own land the
          // whole time (the total-loss death needs no head contact at all).
          markPilot.fly([parkSpot(centerOf(markHome), size)]);
          thiefPilot.fly(raidWaypoints(centerOf(bounds(thiefT)), markHome, 4));
        };
        await until(
          () => thief.client.territories.has(markId) && thief.client.territories.has(thiefId),
          'both start blocks synced',
        );
        replan();
        // Self-healing: any death that is not the win (a raider self-cut, a
        // rare parked-orbit self-cut) leaves both respawned — replan from
        // the fresh blocks and raid again.
        let deathsSeen = 0;
        const win = await until(
          () => {
            const deaths = thief.client.deaths;
            const winning = deaths.find((d) => d.victimId === markId && d.cause === 'totalLoss');
            if (winning) return winning;
            if (deaths.length > deathsSeen) {
              deathsSeen = deaths.length;
              replan();
            }
            return null;
          },
          'the total-loss death',
          150_000,
        );
        expect(win.killerId).toBe(thiefId);
        expect(win.cause).toBe('totalLoss');
        // The mark saw its own death and respawned on a fresh block.
        await until(
          () => mark.client.deaths.some((d) => d.victimId === markId && d.cause === 'totalLoss'),
          'the mark learning of its death',
        );
        await until(
          () => Math.abs(thief.client.territoryAreaOf(markId) - 36) < 0.5,
          'the respawn block sync',
        );
        await until(
          () => thief.client.snapshot?.players.some((p) => p.id === markId),
          'the mark back in snapshots',
        );
      } finally {
        thief.ws.close();
        mark.ws.close();
      }
    },
  );

  it(
    'enclosing part of a territory steals only that part — the enclosed head survives on the rest',
    { timeout: 240_000 },
    async () => {
      const thief = await connect('thief2');
      const mark = await connect('mark2');
      try {
        await until(() => thief.client.self(), 'thief spawn');
        await until(() => mark.client.self(), 'mark spawn');
        const size = thief.client.arenaSizeWU ?? 0;
        const thiefId = thief.client.playerId ?? -1;
        const markId = mark.client.playerId ?? -1;
        const markPilot = autopilot(mark.client, markId, size);
        const thiefPilot = autopilot(thief.client, thiefId, size);
        const thiefHome = (): Point =>
          centerOf(bounds(thief.client.territories.get(thiefId) ?? []));
        const markArea = (): number => thief.client.territoryAreaOf(markId);
        await until(
          () => thief.client.territories.has(markId) && thief.client.territories.has(thiefId),
          'both start blocks synced',
        );

        // A raid can, on unlucky respawn geometry, consume the whole lobe —
        // that is the OTHER test's outcome; here it just means regrow and
        // raid again from the fresh state.
        for (let cycle = 0; ; cycle++) {
          // 1. The mark grows a lobe pointing out of the future enclosure —
          //    land that must survive the raid.
          const markBox = bounds(
            await until(() => thief.client.territories.get(markId), "the mark's block"),
          );
          const markMid = centerOf(markBox);
          thiefPilot.fly([thiefHome()]); // loiter at home
          markPilot.fly(lobeWaypoints(markMid, lobeDirection(markMid, thiefHome(), size)));
          let markDeaths = deathsOf(mark.client, markId);
          const grown = await until(
            () => {
              // A failed lobe (self-cut under feedback lag) → fresh block, retry.
              if (deathsOf(mark.client, markId) > markDeaths) return 'died';
              const area = markArea();
              return area > 45 ? area : null;
            },
            "the mark's lobe fill",
            120_000,
          );
          if (grown === 'died') continue;

          // 2. The thief encircles only the ORIGINAL block; the mark parks
          //    inside it — its head gets enclosed, its lobe does not.
          markPilot.fly([parkSpot(markMid, size)]);
          thiefPilot.fly(raidWaypoints(thiefHome(), markBox, 4));
          markDeaths = deathsOf(mark.client, markId);
          let thiefDeaths = deathsOf(thief.client, thiefId);
          const outcome = await until(
            () => {
              if (deathsOf(mark.client, markId) > markDeaths) return 'wiped';
              const thiefs = deathsOf(thief.client, thiefId);
              if (thiefs > thiefDeaths) {
                // Raider self-cut — re-raid from the respawn block.
                thiefDeaths = thiefs;
                thiefPilot.fly(raidWaypoints(thiefHome(), markBox, 4));
              }
              return markArea() < grown - 30 ? 'stolen' : null;
            },
            'the raid outcome',
            120_000,
          );
          if (outcome === 'stolen') break;
          if (cycle >= 3) throw new Error('raid kept consuming the whole lobe');
        }

        // The mark survived with the un-enclosed lobe remainder — its head
        // (enclosed, parked on stolen land) never died in the final raid.
        expect(markArea()).toBeGreaterThan(0);
        const alive = await until(
          () => thief.client.snapshot?.players.find((p) => p.id === markId),
          'the mark still in snapshots',
        );
        expect(alive.id).toBe(markId);
      } finally {
        thief.ws.close();
        mark.ws.close();
      }
    },
  );
});
