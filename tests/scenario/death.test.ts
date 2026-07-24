import { SELF } from 'cloudflare:test';
import {
  BALANCE,
  TICK_DT_SEC,
  type Point,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import { SimClient, type DeathUpdate } from '@paintclash/sim-client';
import { describe, expect, it } from 'vitest';

/** Head travel per tick — 0.45 WU at the spec §10 start values. */
const STEP_WU = BALANCE.movement.speedWuPerSec * TICK_DT_SEC;

/**
 * Scenario (ticket 05, spec §2.1): real Arena-DO in workerd, two headless
 * sim-clients over the real wire. Spawns are random (the DO seeds itself),
 * so both scenarios STEER by feedback from the snapshots instead of relying
 * on any fixed geometry.
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

  it('attacking a head parked on its own land kills only the attacker (eigenes Gebiet = sicher)', async () => {
    const attacker = await connect('attacker');
    const defender = await connect('defender');
    try {
      await until(() => attacker.client.self(), 'attacker spawn');
      await until(() => defender.client.self(), 'defender spawn');
      const attackerId = attacker.client.playerId ?? -1;
      const defenderId = defender.client.playerId ?? -1;
      const deaths = trackDeaths(defender.client);

      // Defender station-keeps around its block center: bang-bang pursuit
      // of a static point loiters on a turn-radius circle (r ≈ 1.6 WU) —
      // always inside the 6×6 block, so it never grows a trail and stays
      // on own land (= safe, spec §2.1).
      const home = await until(
        () => defender.client.territories.get(defenderId),
        "defender's own block",
      );
      const center = ringCenter(home);
      defender.client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === defenderId);
        if (!self) return;
        defender.client.queueTurn(steerToward(self, center));
        defender.client.flush();
      };
      // Attacker homes straight onto the defender's head.
      attacker.client.onSnapshot = (snapshot) => {
        const self = snapshot.players.find((p) => p.id === attackerId);
        const foe = snapshot.players.find((p) => p.id === defenderId);
        if (!self || !foe) return;
        attacker.client.queueTurn(steerToward(self, [foe.x, foe.y]));
        attacker.client.flush();
      };

      const death = await until(() => deaths[0], 'the attacker dying at the block');
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
      attacker.ws.close();
      defender.ws.close();
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
});
