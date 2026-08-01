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

/** Heading change per full-rate turn tick — 16° at the spec §10 start values. */
const RAD_PER_TICK = (BALANCE.movement.turnRateDegPerSec * Math.PI * TICK_DT_SEC) / 180;

/**
 * Scenario (ticket 07, spec §6.1): the death rules stay fair through REAL
 * latency — a real Arena-DO in workerd, sim-clients on the real binary
 * protocol (v5, carrying the view tick), and ~200 ms in each direction on
 * the attackers' links.
 *
 * The defender station-keeps inside its own 6×6 block: bang-bang pursuit of
 * the block centre loiters at the turn radius (r ≈ 1.6 WU), so it never grows
 * a trail and never leaves its own land — safe, spec §2.1. The attackers see
 * only the delayed stream, so they aim at a ghost and the server judges them
 * with the rewind. The outcome must not change: whoever charges a head parked
 * on its own land dies, and the parked head lives. That shield surviving the
 * rewound passes is exactly the regression this ticket could have broken —
 * the rewound judgment must carry the viewed tick's safety, not the actor's.
 *
 * The rewind's own arithmetic (a kill landing while the live heads are out of
 * reach, plus its negative control) is pinned deterministically one seam
 * down, in `packages/server/src/rewind-latency.test.ts`: over the wire the
 * two heads and the ghost share one 3.2 WU circle, so which contact a tick
 * sees first is luck, and a coin flip is no regression guard.
 */

const LATENCY_MS = 200;
/**
 * Ticks of dead time in an attacker's control loop: its snapshot is one
 * latency old and its intent needs another to arrive. Continuous bang-bang
 * steering across that gap keeps correcting a heading it has already
 * corrected — it chatters, and a chattering path at a 1.6 WU turn radius
 * curls into its own trail (measured: attackers self-cut 35–140 WU out,
 * never reaching the defender). So each attacker plans OPEN-LOOP turn
 * scripts one dead time long: tick-mapped inputs (ticket 17) execute a
 * script exactly, whatever the latency.
 */
const PLAN_TICKS = Math.round((2 * LATENCY_MS) / (1000 * TICK_DT_SEC));
/** Turning ticks per plan, leaving room for a straight run (no curl-back). */
const MAX_ALIGN_TICKS = PLAN_TICKS - 2;
/** Below this gap an attacker stops planning and presses in on the block. */
const LOITER_GAP_WU = 5;
/** Independent hunters — respawns land ~100 WU out, so one alone is slow. */
const ATTACKERS = 3;
/**
 * Charges to watch resolve before judging the invariant. Two is what keeps
 * the wall clock honest: three took ~53 s of the 100 s budget, and the wait
 * is bounded below by the ~11 s a respawn needs to travel back in.
 */
const CHARGES = 2;

/**
 * A fresh caller address per socket (README rule 6, ticket 15). Socket opens are
 * rate-limited per address and one address may hold only so many at once
 * (spec §8.3 point 3) — sharing one across a suite that opens dozens would make
 * a choreography fail for a reason that has nothing to do with what it tests.
 */
let nextCaller = 0;
function freshCaller(): string {
  nextCaller += 1;
  return `192.0.2.${String(nextCaller)}`;
}

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

/** Connect a sim-client; `delayMs` > 0 delays every frame in BOTH directions. */
async function connect(name: string, delayMs = 0): Promise<{ client: SimClient; ws: WebSocket }> {
  const response = await SELF.fetch('https://arena/ws', {
    headers: { Upgrade: 'websocket', 'CF-Connecting-IP': freshCaller() },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error('server did not upgrade the connection');
  ws.accept();
  const deliver = (frame: Uint8Array): void => {
    try {
      ws.send(frame);
    } catch {
      // The socket can close while a delayed frame is still in flight.
    }
  };
  const client = new SimClient((frame) => {
    if (delayMs > 0) setTimeout(() => deliver(frame), delayMs);
    else deliver(frame);
  }, name);
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') return;
    const data = event.data;
    if (delayMs > 0) setTimeout(() => client.receive(data), delayMs);
    else client.receive(data);
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

describe('death rules through real latency (ticket 07)', () => {
  it(
    'charging a head parked on its own land still kills only the charger',
    { timeout: 120_000 },
    async () => {
      const defender = await connect('defender');
      const attackers = await Promise.all(
        Array.from({ length: ATTACKERS }, (_, i) => connect(`attacker${String(i)}`, LATENCY_MS)),
      );
      const sockets = [defender, ...attackers];
      try {
        await until(
          () => defender.client.self(),
          () => 'defender spawn',
        );
        const defenderId = defender.client.playerId ?? -1;
        await until(
          () => (defender.client.snapshot?.players.length ?? 0) >= 1 + ATTACKERS,
          () => 'all attackers spawned',
        );

        // Everything is judged by the server and observed on the UNDELAYED
        // connection, so the log is in true tick order.
        const deaths: DeathUpdate[] = [];
        defender.client.onDeath = (death) => {
          deaths.push(death);
        };

        // Defender: loiter inside the own block — no trail, always safe. The
        // territory is re-read each tick, so a respawn just moves it along.
        defender.client.onSnapshot = (snapshot) => {
          const self = snapshot.players.find((p) => p.id === defenderId);
          const home = defender.client.territories.get(defenderId);
          if (!self || !home || home.length === 0) return;
          defender.client.queueTurn(steerToward(self, ringCenter(home)));
          defender.client.flush();
        };

        // Attackers: charge the defender's head AS THEY SEE IT — with a
        // delayed stream that is a ghost by construction, and the view tick
        // they report is that ghost's tick.
        let closestGapWU = Infinity;
        for (const attacker of attackers) {
          let script: TurnSignal[] = [];
          attacker.client.onSnapshot = (snapshot) => {
            const self = snapshot.players.find((p) => p.id === attacker.client.playerId);
            const foe = snapshot.players.find((p) => p.id === defenderId);
            if (!self || !foe) return;
            const gap = Math.hypot(foe.x - self.x, foe.y - self.y);
            closestGapWU = Math.min(closestGapWU, gap);
            let turn: TurnSignal = 1;
            if (gap < LOITER_GAP_WU) {
              script = []; // arrived: hold the turn and press in on the block
            } else {
              if (script.length === 0) {
                const arc = shortestArc(self.heading, Math.atan2(foe.y - self.y, foe.x - self.x));
                const align = Math.min(MAX_ALIGN_TICKS, Math.round(Math.abs(arc) / RAD_PER_TICK));
                const sign: TurnSignal = arc > 0 ? 1 : -1;
                script = [
                  ...Array.from<unknown, TurnSignal>({ length: align }, () => sign),
                  ...Array.from<unknown, TurnSignal>({ length: PLAN_TICKS - align }, () => 0),
                ];
              }
              turn = script.shift() ?? 0;
            }
            attacker.client.queueTurn(turn);
            attacker.client.flush();
          };
        }

        // Watch a few charges resolve — an attacker dies to the defender, to
        // a rival hunter converging on the same block, or to its own trail;
        // which one is luck, and the invariant does not depend on it.
        await until(
          () => deaths.length >= CHARGES && closestGapWU < LOITER_GAP_WU,
          () =>
            `${String(CHARGES)} charges to resolve (closest approach ${String(
              Math.round(closestGapWU * 10) / 10,
            )} WU; deaths so far: ${
              deaths.map((d) => `${String(d.victimId)}/${d.cause}`).join(', ') || 'none'
            })`,
          100_000,
        );

        // The parked head is safe THROUGH the rewind: heads charged it and
        // died, and it never died to a collision itself — not to a live pass,
        // and not to a rewound one judging its ghost as if it had been out on
        // foreign ground (losing all its land to a fill would be legitimate,
        // so `totalLoss` is not part of the shield invariant).
        expect(deaths.filter((d) => d.victimId === defenderId && d.cause !== 'totalLoss')).toEqual(
          [],
        );
        // The arena plays on: the charger respawned, everyone is still in.
        await until(
          () => (defender.client.snapshot?.players.length ?? 0) >= 1 + ATTACKERS,
          () => 'everyone back in snapshots',
        );
      } finally {
        for (const { ws } of sockets) ws.close();
      }
    },
  );
});
