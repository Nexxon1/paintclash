import { SELF } from 'cloudflare:test';
import {
  BALANCE,
  TICK_DT_SEC,
  type Point,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import { SimClient, type DeathUpdate } from '@paintclash/sim-client';
import { advancePlayer, pointInTerritory } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

/** Heading change per full-rate turn tick — 16° at the spec §10 start values. */
const RAD_PER_TICK = (BALANCE.movement.turnRateDegPerSec * Math.PI * TICK_DT_SEC) / 180;

/**
 * Scenario (ticket 07, spec §6.1): the death rules stay fair through REAL
 * latency — a real Arena-DO in workerd, sim-clients on the real binary
 * protocol (v5, carrying the view tick), and ~200 ms in each direction on
 * the attackers' links.
 *
 * The defender parks on its own land. The attackers see only the delayed
 * stream, so they aim at a ghost and the server judges them with the rewind.
 * The outcome must not change: whoever charges a head parked on its own land
 * dies, and the parked head lives. That shield surviving the rewound passes is
 * exactly the regression this ticket could have broken — the rewound judgment
 * must carry the viewed tick's safety, not the actor's.
 *
 * "Parked" is the PREMISE of that rule, and a state the defender has to earn
 * first — the same lesson `death.test.ts` records for ticket 05. A head never
 * stands still: it loiters on a turn-radius circle 3.2 WU across, which does
 * not fit inside a 6 WU start block from its center, so the orbit pokes past
 * the edge. Out there the defender grows a cuttable trail and is no longer safe
 * for a head-on either; the pokes fill themselves back in, but they heal to
 * exactly the orbit, leaving the head running along its own boundary forever
 * (measured on the bare block: outside its own land ~half of all ticks, a fill
 * every few ticks). Charge that and an attacker eventually cuts a poke — a
 * legitimate kill against a head that was never parked. So the defender widens
 * its home with one box loop FIRST, then parks deep inside it.
 *
 * Settling also clears the defender's rewind past, which is what makes the
 * premise hold against the pass under test: a retired trail stays cuttable
 * until no history entry references it (`LIMITS.rewindMaxTicks` = 10 ticks),
 * so the parked head is only truly out of reach once it has gone a full orbit
 * without filling. `SETTLED_TICKS` outlasts that window on purpose.
 *
 * What this test asserts is therefore the NEGATIVE half — the parked head
 * lives — and that is deliberate. The rewind's own arithmetic (a kill landing
 * while the live heads are out of reach, a lagged cut of an already-filled
 * trail, and a negative control for each) is pinned deterministically one seam
 * down, in `packages/server/src/rewind-latency.test.ts`, and the positive half
 * ("the charger dies") at zero latency in `death.test.ts`: over the wire the
 * two heads and the ghost share one 3.2 WU circle, so which contact a tick
 * sees first is luck, and a coin flip is no regression guard. The swarm's job
 * here is to put real, laggy heads in reach of the rewound passes — measured:
 * within 2–3 WU of the parked head every run, a head-on kill credited to the
 * defender in about half of them — while the shield holds.
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
/**
 * Below this gap an attacker stops planning and charges the head it sees. The
 * last stretch is shorter than one dead time (8 ticks ≈ 3.6 WU of travel), so
 * there is nothing left to plan around: a script would aim at a ghost of a
 * ghost, while steering at the seen head every tick lands the contact the
 * server then judges with the rewind. Blindly holding the turn instead — what
 * a charge onto a bare 6 WU block could get away with — just closes the
 * attacker's own 3.2 WU circle: it self-cuts 2–4 WU short and the parked head
 * is never touched at all.
 */
const CHARGE_HOME_WU = 5;
/** Independent hunters — respawns land ~100 WU out, so one alone is slow. */
const ATTACKERS = 3;
/**
 * Charges to watch resolve before judging the invariant. Two is what keeps
 * the wall clock honest: three took ~53 s of the 100 s budget, and the wait
 * is bounded below by the ~11 s a respawn needs to travel back in.
 */
const CHARGES = 2;
/**
 * Consecutive ticks on own land that count as parked: one full revolution
 * (2πr / 0.45 WU per tick ≈ 23) — and comfortably past the 10-tick rewind
 * window, so the last poke's retired trail is unreachable by then.
 */
const SETTLED_TICKS = 25;

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

/** Poll until it holds; a miss is the caller's to interpret, not a throw. */
async function waitFor(probe: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
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

/** A death as the defender's connection saw it, plus the premise at that moment. */
type StampedDeath = DeathUpdate & { settled: boolean };

describe('death rules through real latency (ticket 07)', () => {
  it(
    'charging a head parked on its own land still kills only the charger',
    // Budget per attempt = the stage waits below (40 + 15 + 60 s), and a missed
    // premise buys one more — the timeout has to clear 2 × 115 s, or the retry
    // would die as an opaque test timeout instead of reporting itself.
    { timeout: 240_000 },
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
        const size = defender.client.arenaSizeWU ?? BALANCE.arena.sizeWU;
        await until(
          () => (defender.client.snapshot?.players.length ?? 0) >= 1 + ATTACKERS,
          () => 'all attackers spawned',
        );

        // Defender: fly the pilot's plan — first the widening lap, then the
        // parked orbit. The territory is re-read each tick, so a respawn just
        // moves the verdict along with it.
        const pilot = new WaypointPilot(size);
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

        // Everything is judged by the server and observed on the UNDELAYED
        // connection, so the log is in true tick order. Each death carries
        // whether the defender was parked when it landed — the line between
        // the rule under test and a choreography that drifted off its land.
        const deaths: StampedDeath[] = [];
        defender.client.onDeath = (death) => {
          deaths.push({ ...death, settled: safeStreak >= SETTLED_TICKS });
        };

        // Attackers: charge the defender's head AS THEY SEE IT — with a
        // delayed stream that is a ghost by construction, and the view tick
        // they report is that ghost's tick. Until the defender is parked they
        // loiter on their own blocks: a charge onto a head still out widening
        // its home would be a legitimate kill and prove nothing.
        let charging = false;
        let closestGapWU = Infinity;
        for (const attacker of attackers) {
          let script: TurnSignal[] = [];
          attacker.client.onSnapshot = (snapshot) => {
            const self = snapshot.players.find((p) => p.id === attacker.client.playerId);
            const foe = snapshot.players.find((p) => p.id === defenderId);
            if (!self) return;
            if (!charging || !foe) {
              const own = attacker.client.territories.get(attacker.client.playerId ?? -1) ?? [];
              script = [];
              attacker.client.queueTurn(own.length > 0 ? steerToward(self, ringCenter(own)) : 0);
              attacker.client.flush();
              return;
            }
            const gap = Math.hypot(foe.x - self.x, foe.y - self.y);
            closestGapWU = Math.min(closestGapWU, gap);
            // Aim where the head WILL be, not where it was: the snapshot is a
            // dead time old, and a parked head circles its orbit in ~23 ticks,
            // so the ghost is most of a revolution out of phase. The wire hands
            // a client heading and turn precisely so it can run the same
            // movement math forward (spec §6.4) — without that lead nobody ever
            // arrives: measured, every charge then self-cuts 2–4 WU short and
            // the parked head is never contacted at all.
            const lead = { x: foe.x, y: foe.y, heading: foe.heading, turn: foe.turn };
            for (let t = 0; t < PLAN_TICKS; t++) advancePlayer(lead, size, TICK_DT_SEC);
            let turn: TurnSignal = 1;
            if (gap < CHARGE_HOME_WU) {
              // Arrived: charge the led point, re-aimed every tick.
              script = [];
              turn = steerToward(self, [lead.x, lead.y]);
            } else {
              if (script.length === 0) {
                const arc = shortestArc(self.heading, Math.atan2(lead.y - self.y, lead.x - self.x));
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

        // Two attempts. Anything that misses the premise — a widening lap that
        // never closed, an orbit that would not settle, a defender killed while
        // it had drifted off its land or stripped of its home by a fill — is
        // the choreography failing, not the rule, and buys another attempt from
        // the fresh state. A defender death while it WAS parked is the
        // regression this test guards: it falls through to the assertions.
        //
        // Every miss records WHICH stage missed. A premise failure that only
        // says "it did not work" costs a full debugging session next time it
        // shows up in CI; the stage name says where to look, and with the seed
        // pinned (`wrangler.jsonc`) it can be replayed locally.
        let resolved: StampedDeath[] | null = null;
        const missed: string[] = [];
        for (let attempt = 0; attempt < 2 && resolved === null; attempt++) {
          charging = false;
          const ownDeaths = (): number =>
            defender.client.deaths.filter((d) => d.victimId === defenderId).length;
          const before = ownDeaths();

          // 1. Widen the home: one box loop around the CURRENT land, closed on
          //    it, so the fill takes the whole box. A second attempt widens
          //    again rather than trusting the first box — an engagement it just
          //    watched may have carved a bite out of it, and a park spot has to
          //    be earned against the ground as it is now, not as it was.
          const block = bounds(
            await until(
              () => defender.client.territories.get(defenderId),
              () => "defender's block",
            ),
          );
          const areaBefore = defender.client.territoryAreaOf(defenderId);
          const box = boxAround(block, size);
          pilot.fly([...corners(box), centerOf(block)]);
          const grown = await waitFor(
            () =>
              ownDeaths() > before ||
              defender.client.territoryAreaOf(defenderId) > areaBefore + 100,
            40_000,
          );
          if (!grown) {
            missed.push(
              `widening lap never closed (area ${defender.client.territoryAreaOf(defenderId).toFixed(1)} WU² from ${areaBefore.toFixed(1)}, box ${box.minX.toFixed(1)},${box.minY.toFixed(1)}–${box.maxX.toFixed(1)},${box.maxY.toFixed(1)})`,
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
          if (!(await waitFor(() => safeStreak >= SETTLED_TICKS, 15_000))) {
            missed.push(`orbit never settled inside the fill (best streak ${String(safeStreak)})`);
            continue;
          }

          // 3. Charge. The record starts HERE: a death from the widening
          //    flight (the defender was out in the open then) must not be
          //    mistaken for the outcome of a charge onto a parked head.
          //    Watch a few charges resolve — an attacker dies to the defender,
          //    to a rival hunter converging on the same block, or to its own
          //    trail; which one is luck, and the invariant does not depend on
          //    it.
          deaths.length = 0;
          closestGapWU = Infinity;
          charging = true;
          const engaged = await waitFor(
            () => deaths.length >= CHARGES && closestGapWU < CHARGE_HOME_WU,
            60_000,
          );
          charging = false;
          if (!engaged) {
            missed.push(
              `the charge never landed: ${String(deaths.length)} of ${String(CHARGES)} deaths, closest approach ${String(Math.round(closestGapWU * 10) / 10)} WU (needs under ${String(CHARGE_HOME_WU)})`,
            );
            continue;
          }
          // Same-tick partners arrive in the same frame batch, a follow-up cut
          // a tick or two later — let the whole engagement land before judging.
          await sleep(300);
          const ownLosses = deaths.filter((d) => d.victimId === defenderId);
          if (ownLosses.some((d) => !d.settled)) {
            missed.push('defender died while it had drifted off its own land');
            continue;
          }
          if (ownLosses.some((d) => d.cause === 'totalLoss')) {
            // Losing every last WU² to a fill is a legitimate death, so it is
            // not part of the shield invariant — but it also ends the parked
            // premise, and the deaths after it were judged against a defender
            // back on a bare 6 WU respawn block.
            missed.push('the defender was filled out of its home — the parked premise ended there');
            continue;
          }
          resolved = [...deaths];
        }
        if (resolved === null) {
          throw new Error(
            `the defender never held a parked charge — attempts: ${missed.join('; ')}`,
          );
        }

        // The parked head is safe THROUGH the rewind: heads charged it and
        // died, and it never died to a collision itself — not to a live pass,
        // and not to a rewound one judging its ghost as if it had been out on
        // foreign ground.
        expect(resolved.filter((d) => d.victimId === defenderId)).toEqual([]);
        // The arena plays on: the charger respawned, everyone is still in.
        await until(
          () => (defender.client.snapshot?.players.length ?? 0) >= 1 + ATTACKERS,
          () => 'everyone back in snapshots',
        );
      } finally {
        defender.client.onSnapshot = null;
        for (const { client } of attackers) client.onSnapshot = null;
        for (const { ws } of sockets) ws.close();
      }
    },
  );
});
