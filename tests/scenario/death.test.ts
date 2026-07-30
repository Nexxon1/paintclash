import { SELF } from 'cloudflare:test';
import {
  BALANCE,
  TICK_DT_SEC,
  type Point,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import { SimClient, type DeathUpdate } from '@paintclash/sim-client';
import { pointInTerritory } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

/** Head travel per tick — 0.45 WU at the spec §10 start values. */
const STEP_WU = BALANCE.movement.speedWuPerSec * TICK_DT_SEC;

/**
 * Scenario (ticket 05, spec §2.1): real Arena-DO in workerd, two headless
 * sim-clients over the real wire.
 *
 * Production spawns are random; the scenario suite pins the arena seed
 * (`wrangler.jsonc` → `ARENA_SEED`) so a run is REPRODUCIBLE — a choreography
 * that works works every time, and a CI failure can be replayed locally. The
 * pin is a convenience, not a contract: everything below still STEERS by
 * feedback from the snapshots rather than assuming any fixed geometry.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
  probe: () => T | null | undefined | false,
  what: string,
  timeoutMs = 25000,
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

/** Poll until it holds; a miss is the caller's to interpret, not a throw. */
async function waitFor(probe: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/** Vertex average of a territory's first ring — good enough as a home point. */
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

function corners(b: Bounds): Point[] {
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
}

/**
 * The box a start block is widened into: `margin` WU out on every side, kept
 * just inside the walls so all four corners are flyable. Flown as a closed
 * loop it fills to ~250 WU² — room for a parked orbit to run WU clear of any
 * edge, which a bare 6 WU block does not have.
 */
function boxAround(block: Bounds, arenaSizeWU: number, margin = 5): Bounds {
  const inside = (v: number): number => Math.min(arenaSizeWU - 1, Math.max(1, v));
  return {
    minX: inside(block.minX - margin),
    minY: inside(block.minY - margin),
    maxX: inside(block.maxX + margin),
    maxY: inside(block.maxY + margin),
  };
}

/** Waypoint autopilot; keeps steering at the last waypoint (loiter). */
class WaypointPilot {
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

/** A death stamped with the newest tick known when its frame arrived. */
type StampedDeath = DeathUpdate & { tick: number };

function trackDeaths(client: SimClient): StampedDeath[] {
  const seen: StampedDeath[] = [];
  client.onDeath = (death) => {
    // Death frames precede their tick's snapshot, so simultaneous deaths
    // carry the same stamp — what the same-tick assertions build on.
    seen.push({ ...death, tick: client.snapshot?.tick ?? -1 });
  };
  return seen;
}

describe('death over the real wire (ticket 05)', () => {
  it('cutting the runner’s trail kills exactly the runner, who respawns fresh', async () => {
    const hunter = await connect('hunter');
    const runner = await connect('runner');
    try {
      await until(() => hunter.client.self(), 'hunter spawn');
      await until(() => runner.client.self(), 'runner spawn');
      const hunterId = hunter.client.playerId ?? -1;
      const runnerId = runner.client.playerId ?? -1;
      const deaths = trackDeaths(hunter.client);

      // Runner flees the hunter — its trail grows as a static polyline
      // between its spawn and its head.
      runner.client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === runnerId);
        if (!self) return;
        const foe = snapshot.players.find((p) => p.id === hunterId);
        const away: Point = foe ? [2 * self.x - foe.x, 2 * self.y - foe.y] : [self.x, self.y];
        runner.client.queueTurn(foe ? steerToward(self, away) : 0);
        runner.client.flush();
      };
      // Hunter aims at a STATIC point of the trail — the runner's pose 40
      // ticks after first contact (≈ 12+ WU out of its block, and ever
      // further behind the fleeing head: a pure cut, never a head-on). A
      // *receding* target (e.g. "N poses behind the head") would tail-chase
      // at equal speed and, with the steering deadband, hover just outside
      // the 0.5 WU cut radius forever.
      const TRAIL_ANCHOR = 40;
      const history: Point[] = [];
      hunter.client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === hunterId);
        const prey = snapshot.players.find((p) => p.id === runnerId);
        if (prey) history.push([prey.x, prey.y]);
        if (!self || history.length === 0) return;
        // Until the anchor exists, chase the head directly — the fleeing
        // runner keeps the gap far beyond head-on range.
        const target = history[Math.min(TRAIL_ANCHOR, history.length - 1)];
        if (!target) return;
        hunter.client.queueTurn(steerToward(self, target));
        hunter.client.flush();
      };

      const death = await until(() => deaths[0], 'the trail cut');
      expect(death.victimId).toBe(runnerId);
      expect(death.killerId).toBe(hunterId);
      expect(death.cause).toBe('trailCut');
      // The runner also saw its own death (broadcast to everyone).
      await until(
        () => runner.client.deaths.some((d) => d.victimId === runnerId),
        'the runner learning of its death',
      );
      // Correct dead only: the hunter survived the whole exchange.
      expect(deaths.some((d) => d.victimId === hunterId)).toBe(false);
      // The victim respawned: fresh 6×6 start block, still in snapshots.
      await until(
        () => Math.abs(hunter.client.territoryAreaOf(runnerId) - 36) < 0.5,
        'the respawn block sync',
      );
      const alive = await until(
        () => hunter.client.snapshot?.players.find((p) => p.id === runnerId),
        'the runner back in snapshots',
      );
      expect(alive.id).toBe(runnerId);
    } finally {
      hunter.ws.close();
      runner.ws.close();
    }
  });

  it('a frontal meeting outside kills both in the same tick (beide draußen → beide tot)', async () => {
    const a = await connect('anna');
    const b = await connect('bert');
    try {
      await until(() => a.client.self(), 'anna spawn');
      await until(() => b.client.self(), 'bert spawn');
      const aId = a.client.playerId ?? -1;
      const bId = b.client.playerId ?? -1;
      const deaths = trackDeaths(a.client);

      // Both run LEAD pursuit onto each other (aim where the other will
      // be): plain mutual pursuit of equal-speed turners can lock into a
      // stable orbit at twice the turn radius — leading the target turns
      // the chase into an interception, i.e. a frontal meeting.
      const engage = (client: SimClient, selfId: number, foeId: number): void => {
        let prevFoe: Point | null = null;
        client.onSnapshot = (snapshot) => {
          const self = snapshot.players.find((p) => p.id === selfId);
          const foe = snapshot.players.find((p) => p.id === foeId);
          if (!foe || !self) return;
          const velocity: Point = prevFoe ? [foe.x - prevFoe[0], foe.y - prevFoe[1]] : [0, 0];
          prevFoe = [foe.x, foe.y];
          const gap = Math.hypot(foe.x - self.x, foe.y - self.y);
          const leadTicks = gap / (2 * STEP_WU); // half the mutual closing time
          const target: Point = [foe.x + velocity[0] * leadTicks, foe.y + velocity[1] * leadTicks];
          client.queueTurn(steerToward(self, target));
          client.flush();
        };
      };
      engage(a.client, aId, bId);
      engage(b.client, bId, aId);

      // Both die in the SAME tick — lone deaths (an oblique trail clip on
      // approach) just respawn and re-engage until the frontal hit lands.
      const sameTick = await until(() => {
        for (const death of deaths) {
          const partner = deaths.find(
            (d) => d.tick === death.tick && d.victimId !== death.victimId,
          );
          if (partner) return [death, partner] as const;
        }
        return null;
      }, 'the mutual kill');
      expect(new Set(sameTick.map((d) => d.victimId))).toEqual(new Set([aId, bId]));
      // Each death names the other as its killer, whatever the exact cause
      // (head-on band, or both heads deep enough for the mutual trail cut).
      for (const death of sameTick) {
        expect(death.killerId).toBe(death.victimId === aId ? bId : aId);
      }
      // Both respawned and play on.
      await until(
        () =>
          a.client.snapshot &&
          [aId, bId].every((id) => a.client.snapshot?.players.some((p) => p.id === id)),
        'both back in snapshots',
      );
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it(
    'attacking a head parked on its own land kills only the attacker (eigenes Gebiet = sicher)',
    // Budget per attempt = the stage waits below (40 + 15 + 60 s), and a missed
    // premise buys one more — the timeout has to clear 2 × 115 s, or the retry
    // would die as an opaque test timeout instead of reporting itself.
    { timeout: 240_000 },
    async () => {
      const attacker = await connect('attacker');
      const defender = await connect('defender');
      try {
        await until(() => attacker.client.self(), 'attacker spawn');
        await until(() => defender.client.self(), 'defender spawn');
        const attackerId = attacker.client.playerId ?? -1;
        const defenderId = defender.client.playerId ?? -1;
        const size = defender.client.arenaSizeWU ?? BALANCE.arena.sizeWU;

        // "Parked on its own land" is the PREMISE of the rule under test — and
        // a state the defender has to earn. A head never stands still: it
        // loiters on a turn-radius circle 3.2 WU across, which does not fit
        // inside a 6 WU start block from its center, so the orbit pokes past
        // the edge. Out there the defender grows a cuttable trail and is no
        // longer safe for a head-on either. Those pokes do fill themselves
        // back in, but they heal to exactly the orbit — leaving the head
        // running along its own boundary forever. So widen the home with one
        // box loop FIRST, then park deep inside it.
        const pilot = new WaypointPilot(size);
        const ORBIT_TICKS = 25; // one revolution: 2πr / 0.45 WU per tick ≈ 23

        /** Consecutive snapshots with the defender's head on its own land. */
        let safeStreak = 0;
        defender.client.onSnapshot = (snapshot) => {
          const self = snapshot.players.find((p) => p.id === defenderId);
          if (!self) return;
          const land = defender.client.territories.get(defenderId) ?? [];
          safeStreak = pointInTerritory(self.x, self.y, land) ? safeStreak + 1 : 0;
          defender.client.queueTurn(pilot.steer(self));
          defender.client.flush();
        };
        // Deaths as the defender's connection sees them, each stamped with
        // whether the defender was settled when it landed.
        const deaths: (StampedDeath & { settled: boolean })[] = [];
        defender.client.onDeath = (death) => {
          deaths.push({
            ...death,
            tick: defender.client.snapshot?.tick ?? -1,
            settled: safeStreak >= ORBIT_TICKS,
          });
        };
        // The attacker loiters on its own block until the defender is parked,
        // then homes straight onto its head.
        let charging = false;
        attacker.client.onSnapshot = (snapshot) => {
          const self = snapshot.players.find((p) => p.id === attackerId);
          if (!self) return;
          const foe = snapshot.players.find((p) => p.id === defenderId);
          const own = attacker.client.territories.get(attackerId) ?? [];
          const target: Point = charging && foe ? [foe.x, foe.y] : ringCenter(own);
          attacker.client.queueTurn(steerToward(self, target));
          attacker.client.flush();
        };

        // Two attempts. Anything that misses the premise — a self-cut on the
        // widening loop, a park spot the orbit cannot hold, a defender death
        // from a trail it had outside — is the choreography failing, not the
        // rule, and buys another attempt from the fresh state. A defender death
        // while it WAS settled is the regression this test guards: it falls
        // through to the assertions and fails there, loudly.
        //
        // Every miss records WHICH stage missed. A premise failure that only
        // says "it did not work" costs a full debugging session next time it
        // shows up in CI; the stage name says where to look, and with the seed
        // pinned (`wrangler.jsonc`) it can be replayed locally.
        let death: (StampedDeath & { settled: boolean }) | null = null;
        const missed: string[] = [];
        for (let attempt = 0; attempt < 2 && death === null; attempt++) {
          charging = false;
          const ownDeaths = (): number =>
            defender.client.deaths.filter((d) => d.victimId === defenderId).length;
          const before = ownDeaths();

          // 1. Widen the home: one box loop around the start block, closed on
          //    the block itself, so the fill takes the whole box.
          const block = bounds(
            await until(() => defender.client.territories.get(defenderId), "defender's block"),
          );
          const box = boxAround(block, size);
          pilot.fly([...corners(box), centerOf(block)]);
          const grown = await waitFor(
            () => ownDeaths() > before || defender.client.territoryAreaOf(defenderId) > 150,
            40_000,
          );
          if (!grown) {
            missed.push(
              `widening lap never closed (area ${defender.client.territoryAreaOf(defenderId).toFixed(1)} WU², box ${box.minX.toFixed(1)},${box.minY.toFixed(1)}–${box.maxX.toFixed(1)},${box.maxY.toFixed(1)})`,
            );
            continue;
          }
          if (ownDeaths() > before) {
            missed.push('defender died on the widening lap (out in the open, premise void)');
            continue;
          }

          // 2. Park at the box center — inside the fresh fill by construction,
          //    and several WU clear of every edge — and let the orbit settle.
          pilot.fly([centerOf(box)]);
          safeStreak = 0;
          if (!(await waitFor(() => safeStreak >= ORBIT_TICKS, 15_000))) {
            missed.push(`orbit never settled inside the fill (best streak ${String(safeStreak)})`);
            continue;
          }

          // 3. Charge. The record starts HERE: a death from the widening flight
          //    (the defender was out in the open then) must not be mistaken for
          //    the outcome of a charge onto a parked head.
          deaths.length = 0;
          charging = true;
          if (!(await waitFor(() => deaths.length > 0, 60_000))) {
            missed.push('the charge never produced a death');
            continue;
          }
          // Same-tick partners arrive in the same frame batch, a follow-up cut
          // a tick or two later — let the whole engagement land before judging.
          await sleep(300);
          const defenderDeath = deaths.find((d) => d.victimId === defenderId);
          if (defenderDeath && !defenderDeath.settled) {
            missed.push('defender died while it had drifted off its own land');
            continue;
          }
          death = deaths[0] ?? null;
        }
        if (!death) {
          throw new Error(
            `the defender never held a parked charge — attempts: ${missed.join('; ')}`,
          );
        }

        expect(death.victimId).toBe(attackerId);
        expect(death.killerId).toBe(defenderId);
        // Usually the pure head-on band (0.5–1 WU); a fast final closing step
        // can land inside 0.5 WU of the attacker's own head-glued trail end,
        // where the safe head's touch counts as the cut instead — same
        // outcome, both rules unit-tested precisely in sim-core.
        expect(['headOn', 'trailCut']).toContain(death.cause);
        // The parked defender never died.
        expect(deaths.some((d) => d.victimId === defenderId)).toBe(false);
      } finally {
        attacker.client.onSnapshot = null;
        defender.client.onSnapshot = null;
        attacker.ws.close();
        defender.ws.close();
      }
    },
  );
});
