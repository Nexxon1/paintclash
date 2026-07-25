import {
  LIMITS,
  TICK_DT_SEC,
  type Point,
  type Territory,
  type TurnSignal,
} from '@paintclash/shared';
import {
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  type ServerMessage,
} from '@paintclash/protocol';
import type { SimState } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

import { ArenaCore } from './arena.js';

/**
 * Kill-fairness with rewind under SIMULATED LATENCY (ticket 07, spec §6.1,
 * ADR-0003) — the integration seam: a real `ArenaCore`, real binary frames,
 * real tick-mapped inputs (ticket 17) and a real delay line in both
 * directions. Only workerd and the socket plumbing are left out (covered by
 * `tests/scenario/`).
 *
 * Deterministic on purpose. The geometry is poised white-box (the pattern the
 * steal tests use): steering two heads into a ghost by pursuit is a coin flip
 * on which contact the tick sees first — measured over the real wire, the
 * live head-on won every time, because a loitering head and its ghost share
 * one 3.2 WU circle. A flaky test proves nothing about fairness. Here the
 * attacker is placed exactly where the defender's ghost was, and the
 * assertion is the one that matters: the death fires although the two LIVE
 * heads are far out of head-on reach, which no un-rewound rule can produce.
 */

/** One-way latency of the lagged link, in ticks (4 ≈ 200 ms at 20 Hz). */
const ONE_WAY_TICKS = 4;
/** Ticks of play before poising — fills the rewind window (10 entries). */
const WARMUP_TICKS = 40;

const STEP_WU = 0.45;
/** Two heads of collision radius 0.5 WU touch head-on at 1 WU. */
const HEAD_ON_WU = 1;
/**
 * Live head distance that provably rules the live head-on pass out: the pass
 * needs the heads within `HEAD_ON_WU`, and two heads close by at most
 * 2 · STEP_WU in the tick between the poise and the judgment.
 */
const PROOF_DISTANCE_WU = HEAD_ON_WU + 2 * STEP_WU;

/**
 * A client on the far end of a delay line: decodes what arrives, sends one
 * tick-mapped intent per snapshot, and reports the tick it is RENDERING —
 * for a headless client that is simply the newest snapshot it has (what
 * `SimClient` does, spec §6.1).
 */
class LaggedClient {
  newestTick = 0;
  readonly deaths: Extract<ServerMessage, { type: 'death' }>[] = [];
  players: { id: number; x: number; y: number; heading: number }[] = [];
  private seq = 0;

  receive(frame: Uint8Array): void {
    const message = decodeServerMessage(frame);
    if (!message) throw new Error('server sent an undecodable frame');
    if (message.type === 'death') this.deaths.push(message);
    if (message.type === 'snapshot' && message.tick > this.newestTick) {
      this.newestTick = message.tick;
      this.players = message.players;
    }
  }

  /** One intent, keyed to the view it was sampled at (ticket 07). */
  input(turn: TurnSignal): Uint8Array {
    this.seq += 1;
    return encodeInput([{ seq: this.seq, turn }], this.newestTick);
  }
}

interface Link {
  client: LaggedClient;
  id: number;
  /** Steering, evaluated on the client's own (possibly stale) view. */
  drive: ((client: LaggedClient) => TurnSignal) | null;
}

/**
 * An arena plus clients whose frames travel with a per-link delay. Deliveries
 * are queued against the tick counter, so the latency is exact and
 * repeatable — no timers, no wall clock.
 */
class LatencyHarness {
  readonly arena = new ArenaCore(1);
  private tick = 0;
  private readonly links: Link[] = [];
  private pending: { dueTick: number; deliver: () => void }[] = [];

  /** Join a client whose frames are delayed `oneWayTicks` in each direction. */
  connect(name: string, oneWayTicks: number): Link {
    const client = new LaggedClient();
    const relay = (deliver: () => void): void => {
      if (oneWayTicks === 0) deliver();
      else this.pending.push({ dueTick: this.tick + oneWayTicks, deliver });
    };
    const id = this.arena.connect({
      send: (frame) => {
        relay(() => {
          client.receive(frame);
        });
      },
      close: () => {
        throw new Error('the arena closed a healthy harness socket');
      },
    });
    if (id === null) throw new Error('arena unexpectedly full');
    this.arena.handleFrame(id, encodeJoin(name));
    const link: Link = { client, id, drive: null };
    this.links.push(link);
    // Sending goes through the same delay line, from wherever `drive` runs.
    const send = (frame: Uint8Array): void => {
      relay(() => {
        this.arena.handleFrame(id, frame);
      });
    };
    this.senders.set(id, send);
    return link;
  }

  private readonly senders = new Map<number, (frame: Uint8Array) => void>();

  /** Deliver everything due, let every client steer, run one tick. */
  step(): void {
    const due = this.pending.filter((p) => p.dueTick <= this.tick);
    this.pending = this.pending.filter((p) => p.dueTick > this.tick);
    for (const { deliver } of due) deliver();
    for (const link of this.links) {
      if (!link.drive) continue;
      this.senders.get(link.id)?.(link.client.input(link.drive(link.client)));
    }
    this.arena.tick(TICK_DT_SEC);
    this.tick += 1;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /** White-box view of the sim (same access the steal tests use). */
  get state(): SimState {
    return (this.arena as unknown as { state: SimState }).state;
  }
}

/** 6×6 block around (cx, cy). */
function blockAt(cx: number, cy: number): Territory {
  return [
    [
      [
        [cx - 3, cy - 3],
        [cx + 3, cy - 3],
        [cx + 3, cy + 3],
        [cx - 3, cy + 3],
      ],
    ],
  ];
}

/** Shortest arc from `from` to `to` in radians. */
function shortestArc(from: number, to: number): number {
  const TWO_PI = 2 * Math.PI;
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

const HOME: Point = [100, 100];

/**
 * Set the scene: a defender loitering inside its own block (bang-bang pursuit
 * of the block centre circles at the turn radius — no trail, never off its
 * own land, so it is a rewind target and never a cut victim), and an attacker
 * parked out on neutral ground whose link lags `oneWayTicks` each way.
 */
function scene(oneWayTicks: number): {
  harness: LatencyHarness;
  defender: Link;
  attacker: Link;
} {
  const harness = new LatencyHarness();
  const defender = harness.connect('defender', 0);
  const attacker = harness.connect('attacker', oneWayTicks);
  harness.step(); // both spawn

  const d = harness.state.players.find((p) => p.id === defender.id);
  const a = harness.state.players.find((p) => p.id === attacker.id);
  if (!d || !a) throw new Error('players not spawned');
  Object.assign(d, { x: HOME[0], y: HOME[1] + 1.5, heading: 0, turn: 0 });
  d.territory = blockAt(HOME[0], HOME[1]);
  d.trail = [];
  // The attacker idles far away, inside its OWN block so it grows no trail
  // while warming up; the poise later moves it out onto neutral ground,
  // where it has no head-on shield (spec §2.1).
  Object.assign(a, { x: 40, y: 40, heading: 0, turn: 0 });
  a.territory = blockAt(40, 40);
  a.trail = [];

  defender.drive = (client) => {
    const self = client.players.find((p) => p.id === defender.id);
    if (!self) return 0;
    const bearing = Math.atan2(HOME[1] - self.y, HOME[0] - self.x);
    const diff = shortestArc(self.heading, bearing);
    return Math.abs(diff) < 0.06 ? 0 : diff > 0 ? 1 : -1;
  };
  // The attacker only keeps its input timeline (and with it the view tick it
  // reports) alive — its position is poised, never steered.
  attacker.drive = () => 0;
  harness.run(WARMUP_TICKS);
  return { harness, defender, attacker };
}

/** Move `a` one step short of `ghost`, so this tick's movement lands on it. */
function poiseOnto(
  a: { x: number; y: number; heading: number; turn: TurnSignal },
  ghost: Point,
): void {
  a.x = ghost[0] - Math.cos(a.heading) * STEP_WU;
  a.y = ghost[1] - Math.sin(a.heading) * STEP_WU;
  a.turn = 0;
}

/**
 * Loop ring that closes on the next inward step (the geometry the steal tests
 * already prove fills), laid so its eastern leg runs far from the block.
 */
const LOOP_RING: readonly Point[] = [
  [102, 100],
  [120, 100],
  [120, 109],
  [100, 109],
  [100, 103.75],
];
/** A point on that eastern leg — 17+ WU from the block the runner returns to. */
const CUT_POINT: Point = [120, 104.5];
/** What the delay line derives: travel each way plus one tick of tick-map margin. */
const EXPECTED_DEPTH = 2 * ONE_WAY_TICKS + 1;

/**
 * The race the rewind exists for, run through the delay line: the runner lays
 * a loop, closes it (so the trail is GONE — retired, spec §2.2) and is home
 * and trail-less; then a cutter's head lands exactly on the vanished trail,
 * at the tick whose rewind reads the pre-fill pose. Live judgment has nothing
 * to work with at all — there is no trail anywhere and the runner's head is
 * far away — so any death here is the rewound cut and nothing else.
 */
function cutTheVanishedTrail(oneWayTicks: number): {
  deaths: Extract<ServerMessage, { type: 'death' }>[];
  depth: number;
  liveDistanceWU: number;
  ghostTrailLen: number;
} {
  const { harness, defender, attacker } = scene(oneWayTicks);
  const runner = harness.state.players.find((p) => p.id === defender.id);
  const cutter = harness.state.players.find((p) => p.id === attacker.id);
  if (!runner || !cutter) throw new Error('players vanished');
  const depth = cutter.viewDelayTicks;

  // Stop steering and let the loiter's last in-flight intents expire before
  // poising: a leftover turn would curve the runner back out of its block and
  // start a fresh trail, blunting the very point that live judgment has no
  // trail to work with.
  defender.drive = null;
  harness.run(2);

  // Lay the loop one step short of re-entry and let a tick RECORD it: the
  // history entry of that tick is the one the rewind will later read.
  Object.assign(runner, { x: 100, y: 103.75, heading: (3 * Math.PI) / 2, turn: 0 });
  runner.trail = LOOP_RING.map(([x, y]): Point => [x, y]);
  harness.step();
  const ghostTick = harness.state.tick;
  const ghostTrailLen = runner.history.find((h) => h.tick === ghostTick)?.trailLen ?? 0;

  // Close the loop: the trail is retired and the runner stands home, safe.
  harness.step();

  // Wait for the tick whose rewind reads that pre-fill entry, then drop the
  // cutter onto the trail that no longer exists.
  while (harness.state.tick < ghostTick + EXPECTED_DEPTH - 1) harness.step();
  const liveDistanceWU = Math.hypot(runner.x - CUT_POINT[0], runner.y - CUT_POINT[1]);
  if (runner.trail.length > 0) throw new Error('the runner should be home and trail-less');
  poiseOnto(cutter, CUT_POINT);
  const before = defender.client.deaths.length;
  harness.step();
  return {
    deaths: defender.client.deaths.slice(before),
    depth,
    liveDistanceWU,
    ghostTrailLen,
  };
}

describe('rewind under simulated latency (ticket 07)', () => {
  it('derives a rewind depth of about the round trip from the reported view ticks', () => {
    const { harness, defender, attacker } = scene(ONE_WAY_TICKS);
    const lagged = harness.state.players.find((p) => p.id === attacker.id);
    const direct = harness.state.players.find((p) => p.id === defender.id);
    // Round trip = snapshot travel + input travel (plus the tick-map margin).
    expect(lagged?.viewDelayTicks).toBeGreaterThanOrEqual(2 * ONE_WAY_TICKS);
    expect(lagged?.viewDelayTicks).toBeLessThanOrEqual(LIMITS.rewindMaxTicks);
    // The undelayed link rewinds barely at all — its view IS the present.
    expect(direct?.viewDelayTicks).toBeLessThanOrEqual(2);
  });

  it('kills the attacker that rammed the ghost, with the live heads out of reach', () => {
    const { harness, defender, attacker } = scene(ONE_WAY_TICKS);
    const a = harness.state.players.find((p) => p.id === attacker.id);
    const d = harness.state.players.find((p) => p.id === defender.id);
    if (!a || !d) throw new Error('players vanished');

    // Where the server will look: the defender's pose at the tick the
    // attacker's pilot was watching when this tick's input was sampled.
    const judgedTick = harness.state.tick + 1 - a.viewDelayTicks;
    const ghost = d.history.find((h) => h.tick === judgedTick);
    if (!ghost) throw new Error('no history entry for the judged tick');
    expect(ghost.safe).toBe(true); // stood on own land — the shield case
    poiseOnto(a, [ghost.x, ghost.y]);

    const before = defender.client.deaths.length;
    harness.step();

    expect(defender.client.deaths.slice(before)).toEqual([
      { type: 'death', victimId: attacker.id, killerId: defender.id, cause: 'headOn' },
    ]);
    // The proof: the ghost the attacker rammed and the defender's LIVE head
    // are far apart, so the live head-on pass (heads within 1 WU) cannot have
    // produced this death — and no cut can, because a head on its own land
    // carries no trail. Only the rewind explains it.
    expect(Math.hypot(ghost.x - d.x, ghost.y - d.y)).toBeGreaterThan(PROOF_DISTANCE_WU);
    // The rammed defender survived: at the viewed tick it stood on its own
    // land, and that shield holds through the rewind (spec §2.1).
    expect(harness.state.players.map((p) => p.id)).toContain(defender.id);
  });

  it('the identical geometry kills nobody on a latency-free link (negative control)', () => {
    // Same scene, same poise, no latency: with nothing to rewind the ghost is
    // not a target and the live heads are metres apart, so nobody dies. This
    // is the "would narrowly miss without rewind" half of the ticket.
    const { harness, defender, attacker } = scene(0);
    const a = harness.state.players.find((p) => p.id === attacker.id);
    const d = harness.state.players.find((p) => p.id === defender.id);
    if (!a || !d) throw new Error('players vanished');
    const ghost = d.history.find((h) => h.tick === harness.state.tick + 1 - 2 * ONE_WAY_TICKS);
    if (!ghost) throw new Error('no history entry to aim at');
    poiseOnto(a, [ghost.x, ghost.y]);

    const before = defender.client.deaths.length;
    harness.step();
    expect(defender.client.deaths.slice(before)).toEqual([]);
    expect(Math.hypot(ghost.x - d.x, ghost.y - d.y)).toBeGreaterThan(PROOF_DISTANCE_WU);
  });

  it('counts a lagged cut of the trail the runner already filled away', () => {
    const { deaths, depth, liveDistanceWU, ghostTrailLen } = cutTheVanishedTrail(ONE_WAY_TICKS);
    // The rewind read a pre-fill pose that still carried the whole loop …
    expect(depth).toBe(EXPECTED_DEPTH);
    expect(ghostTrailLen).toBe(LOOP_RING.length);
    // … so the cut counts, although the trail was gone before the cutter got
    // there: "ich habe den Trail vor mir geschnitten" (ticket 07, spec §6.1).
    expect(deaths).toEqual([{ type: 'death', victimId: 1, killerId: 2, cause: 'trailCut' }]);
    // Live judgment had nothing at all to reach with: no trail existed
    // anywhere (the runner was home) and its head was metres away.
    expect(liveDistanceWU).toBeGreaterThan(10);
  });

  it('the identical cut is a clean miss on a latency-free link (negative control)', () => {
    // Same loop, same fill, same cut point, same tick — but with nothing to
    // rewind, the cutter sweeps through bare ground. This is the ticket's
    // "würde ohne Rewind knapp verfehlt" half, at the latency seam.
    const { deaths, liveDistanceWU } = cutTheVanishedTrail(0);
    expect(deaths).toEqual([]);
    expect(liveDistanceWU).toBeGreaterThan(10);
  });
});
