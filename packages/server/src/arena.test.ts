import { BALANCE, LIMITS, TICK_DT_SEC, type Point } from '@paintclash/shared';
import {
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  type ServerMessage,
} from '@paintclash/protocol';
import { territoryArea, type SimState } from '@paintclash/sim-core';
import { describe, expect, it } from 'vitest';

import { ArenaCore } from './arena.js';

class FakeSocket {
  sent: Uint8Array[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  decoded(): ServerMessage[] {
    return this.sent.map((f) => {
      const m = decodeServerMessage(f);
      if (!m) throw new Error('server sent an undecodable frame');
      return m;
    });
  }

  lastSnapshot(): Extract<ServerMessage, { type: 'snapshot' }> {
    const snapshots = this.decoded().filter((m) => m.type === 'snapshot');
    const last = snapshots[snapshots.length - 1];
    if (!last) throw new Error('no snapshot received');
    return last;
  }
}

function joinedPlayer(arena: ArenaCore, name = 'p'): { socket: FakeSocket; id: number } {
  const socket = new FakeSocket();
  const id = arena.connect(socket);
  if (id === null) throw new Error('arena unexpectedly full');
  arena.handleFrame(id, encodeJoin(name));
  return { socket, id };
}

/** Shortest-arc |b − a| in radians (snapshot headings are wrapped). */
function headingDelta(a: number, b: number): number {
  const TWO_PI = 2 * Math.PI;
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return Math.abs(d);
}

describe('join handshake', () => {
  it('answers a join with a welcome carrying playerId + arena size', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    const welcome = socket.decoded().find((m) => m.type === 'welcome');
    expect(welcome).toEqual({ type: 'welcome', playerId: id, arenaSizeWU: BALANCE.arena.sizeWU });
  });

  it('a custom arena size (dev override, private rooms) reaches the welcome', () => {
    const arena = new ArenaCore(1, 50);
    const { socket } = joinedPlayer(arena);
    const welcome = socket.decoded().find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('no welcome');
    expect(welcome.arenaSizeWU).toBe(50);
  });

  it('spawns the player on the next tick and snapshots them to everyone', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.players.map((p) => p.id)).toContain(id);
  });

  it('assigns distinct player ids per connection', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena);
    const b = joinedPlayer(arena);
    expect(a.id).not.toBe(b.id);
  });
});

describe('authoritative movement (tick-mapped inputs)', () => {
  it('moves heads 0.45 WU per tick — positions come from the server, never the client', () => {
    const arena = new ArenaCore(1);
    const { socket } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    const before = socket.lastSnapshot().players[0];
    arena.tick(TICK_DT_SEC);
    const after = socket.lastSnapshot().players[0];
    if (!before || !after) throw new Error('missing snapshot player');
    const dist = Math.hypot(after.x - before.x, after.y - before.y);
    // f32 wire rounding — generous epsilon.
    expect(dist).toBeGreaterThan(0.4);
    expect(dist).toBeLessThan(0.5);
  });

  it('acks 0 while no input frame ever arrived', () => {
    const arena = new ArenaCore(1);
    const { socket } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(0);
  });

  it('anchors the mapping on the first frame: newest intent applies next tick, older ones are pre-anchor history', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(
      id,
      encodeInput(
        [
          { seq: 1, turn: 0 },
          { seq: 2, turn: 0 },
          { seq: 3, turn: 1 },
        ],
        0,
      ),
    );
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(3);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
  });

  it('processes a dry tick: the ack advances and the last turn persists', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(
      id,
      encodeInput(
        [
          { seq: 1, turn: 0 },
          { seq: 2, turn: 0 },
          { seq: 3, turn: 1 },
        ],
        0,
      ),
    );
    arena.tick(TICK_DT_SEC);
    // No frames in flight — the server keeps simulating the held turn and
    // keeps acking the ticks as processed (they ARE part of the timeline).
    arena.tick(TICK_DT_SEC);
    arena.tick(TICK_DT_SEC);
    let snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(5);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
    // The matching inputs arrive AFTER their ticks already ran → discarded;
    // their (different) turn must NOT bend the already-simulated past.
    arena.handleFrame(
      id,
      encodeInput(
        [
          { seq: 4, turn: -1 },
          { seq: 5, turn: -1 },
        ],
        0,
      ),
    );
    arena.tick(TICK_DT_SEC);
    snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(6);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
  });

  it('applies a short tap for exactly one tick — eager-flushed frames land on their mapped ticks', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(
      id,
      encodeInput(
        [
          { seq: 1, turn: 0 },
          { seq: 2, turn: 0 },
          { seq: 3, turn: 0 },
        ],
        0,
      ),
    );
    arena.tick(TICK_DT_SEC);
    const straight = socket.lastSnapshot();
    expect(straight.ackSeq).toBe(3);
    // Press: the real client flushes ON the change tick, so the change is
    // always the newest item of its frame.
    arena.handleFrame(id, encodeInput([{ seq: 4, turn: 1 }], 0));
    arena.tick(TICK_DT_SEC);
    const pressed = socket.lastSnapshot();
    expect(pressed.ackSeq).toBe(4);
    expect(pressed.players.find((p) => p.id === id)?.turn).toBe(1);
    // Release next tick.
    arena.handleFrame(id, encodeInput([{ seq: 5, turn: 0 }], 0));
    arena.tick(TICK_DT_SEC);
    const released = socket.lastSnapshot();
    expect(released.ackSeq).toBe(5);
    expect(released.players.find((p) => p.id === id)?.turn).toBe(0);
    // The heading rotated during exactly ONE tick — not zero, not two.
    const oneTickRad = (BALANCE.movement.turnRateDegPerSec * Math.PI * TICK_DT_SEC) / 180;
    const hStraight = straight.players.find((p) => p.id === id)?.heading ?? 0;
    const hPressed = pressed.players.find((p) => p.id === id)?.heading ?? 0;
    const hReleased = released.players.find((p) => p.id === id)?.heading ?? 0;
    expect(headingDelta(hStraight, hPressed)).toBeCloseTo(oneTickRad, 3);
    expect(headingDelta(hPressed, hReleased)).toBeCloseTo(0, 3);
  });

  it('keeps a steady batch cadence exact: ack tracks the tick 1:1, turns land on their mapped ticks', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(
      id,
      encodeInput(
        [
          { seq: 1, turn: 1 },
          { seq: 2, turn: 1 },
          { seq: 3, turn: 1 },
        ],
        0,
      ),
    );
    arena.tick(TICK_DT_SEC);
    // Four cadence rounds: each batch fully in flight before its ticks run.
    for (let round = 0; round < 4; round++) {
      const base = 4 + round * 3;
      const turn = round === 3 ? -1 : 1;
      arena.handleFrame(
        id,
        encodeInput(
          [
            { seq: base, turn },
            { seq: base + 1, turn },
            { seq: base + 2, turn },
          ],
          0,
        ),
      );
      for (let i = 0; i < 3; i++) {
        arena.tick(TICK_DT_SEC);
        const snapshot = socket.lastSnapshot();
        // Zero standing backlog: every tick acks exactly its mapped seq.
        expect(snapshot.ackSeq).toBe(base + i);
        expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(turn);
      }
    }
  });

  it('drops a post-stall burst instead of fast-forwarding — those ticks were already simulated', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 0));
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(1);
    // Client stalls for 10 ticks; the server keeps simulating + acking.
    for (let i = 0; i < 10; i++) arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(11);
    const before = socket.lastSnapshot().players.find((p) => p.id === id);
    // The catch-up burst arrives late: only the seqs whose ticks are still
    // ahead survive; the head must advance ONE step, never a replayed dozen.
    const burst = Array.from({ length: 12 }, (_, i) => ({ seq: i + 2, turn: 1 as const }));
    arena.handleFrame(id, encodeInput(burst, 0));
    arena.tick(TICK_DT_SEC);
    const after = socket.lastSnapshot().players.find((p) => p.id === id);
    if (!before || !after) throw new Error('missing snapshot player');
    const dist = Math.hypot(after.x - before.x, after.y - before.y);
    expect(dist).toBeGreaterThan(0.4);
    expect(dist).toBeLessThan(0.5);
    expect(socket.lastSnapshot().ackSeq).toBe(12);
    // The tail of the burst still steers — the player regains control at once.
    expect(after.turn).toBe(1);
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(13);
  });

  it('caps a seq flood at the queue bound and never multi-applies it (spec §8.3)', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 0));
    arena.tick(TICK_DT_SEC);
    const before = socket.lastSnapshot().players.find((p) => p.id === id);
    // Two frames of 20 far-future seqs — a hostile/broken timeline. The
    // second out-of-range frame re-anchors to the newest seq.
    arena.handleFrame(
      id,
      encodeInput(
        Array.from({ length: 20 }, (_, i) => ({ seq: i + 2, turn: 1 as const })),
        0,
      ),
    );
    arena.handleFrame(
      id,
      encodeInput(
        Array.from({ length: 20 }, (_, i) => ({ seq: i + 22, turn: -1 as const })),
        0,
      ),
    );
    arena.tick(TICK_DT_SEC);
    const after = socket.lastSnapshot().players.find((p) => p.id === id);
    if (!before || !after) throw new Error('missing snapshot player');
    // One tick = one step, whatever was queued.
    const dist = Math.hypot(after.x - before.x, after.y - before.y);
    expect(dist).toBeGreaterThan(0.4);
    expect(dist).toBeLessThan(0.5);
    expect(socket.lastSnapshot().ackSeq).toBe(41);
    expect(after.turn).toBe(-1);
  });

  it('drops non-monotonic sequence numbers (server-limited, spec §6.4)', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 10, turn: 1 }], 0));
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(10);
    arena.handleFrame(id, encodeInput([{ seq: 3, turn: -1 }], 0)); // replay/stale
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(11);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
  });
});

describe('tick-offset drift', () => {
  it('gives a knife-edge arrival margin one tick of slack instead of stochastic input loss', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 0));
    // Every frame arrives with zero margin: seq == just-run tick, mapped to
    // the very next tick. The smoothed margin sinks below the floor → the
    // mapping slackens by one tick, once.
    for (let i = 0; i < 30; i++) {
      arena.tick(TICK_DT_SEC);
      const tick = socket.lastSnapshot().tick;
      arena.handleFrame(id, encodeInput([{ seq: tick, turn: 1 }], 0));
    }
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.tick - snapshot.ackSeq).toBe(2); // was 1 at the anchor
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
  });

  it('reclaims chronically idle margin — a standing early-arrival is pure latency', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 0));
    for (let i = 0; i < 40; i++) {
      arena.tick(TICK_DT_SEC);
      const tick = socket.lastSnapshot().tick;
      // Three ticks of headroom on every frame — two of them are reclaimable.
      arena.handleFrame(id, encodeInput([{ seq: tick + 3, turn: 1 }], 0));
    }
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    // The mapping tightened past the anchor: acked seq now LEADS the tick.
    expect(snapshot.ackSeq).toBeGreaterThan(snapshot.tick);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
  });

  it('re-anchors after a client timeline break instead of muting steering forever', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 0));
    let seq = 1;
    for (let i = 0; i < 5; i++) {
      arena.tick(TICK_DT_SEC);
      arena.handleFrame(id, encodeInput([{ seq: ++seq, turn: 0 }], 0));
    }
    // Long client freeze: its clamped catch-up permanently trails the wall
    // clock, so every future seq would map into the already-acked past.
    for (let i = 0; i < 25; i++) arena.tick(TICK_DT_SEC);
    const ackAhead = socket.lastSnapshot().ackSeq;
    expect(ackAhead).toBeGreaterThan(seq);
    // Two consecutive out-of-range frames re-anchor; the second one already
    // steers again.
    arena.handleFrame(id, encodeInput([{ seq: ++seq, turn: -1 }], 0));
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: ++seq, turn: -1 }], 0));
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(-1);
    // The ack rebased onto the client's (older) timeline.
    expect(snapshot.ackSeq).toBe(seq);
  });
});

describe('intent-only validation at the protocol boundary (spec §8.2/8.3)', () => {
  it('silently drops a malformed frame', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    expect(() => {
      arena.handleFrame(id, new Uint8Array([0xba, 0xad]));
    }).not.toThrow();
    expect(socket.closed).toBeNull();
  });

  it('kills the connection after persistent garbage', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    for (let i = 0; i < LIMITS.garbageKillThreshold; i++) {
      arena.handleFrame(id, new Uint8Array([0xba, 0xad]));
    }
    expect(socket.closed).not.toBeNull();
  });

  it('a valid frame resets the garbage tolerance window', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    for (let i = 0; i < LIMITS.garbageKillThreshold - 1; i++) {
      arena.handleFrame(id, new Uint8Array([0xba, 0xad]));
    }
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 0));
    arena.handleFrame(id, new Uint8Array([0xba, 0xad]));
    expect(socket.closed).toBeNull();
  });

  it('sends nothing to a connection that never joined — no inputs, no snapshots', () => {
    const arena = new ArenaCore(1);
    const socket = new FakeSocket();
    const id = arena.connect(socket);
    if (id === null) throw new Error('arena unexpectedly full');
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 1 }], 0));
    arena.tick(TICK_DT_SEC);
    // Spec §8.2: world state only flows after a join.
    expect(socket.sent).toHaveLength(0);
  });

  it('rejects connections beyond the hard population cap (spec §8.3, u8 wire bound)', () => {
    const arena = new ArenaCore(1);
    for (let i = 0; i < LIMITS.maxConnections; i++) {
      expect(arena.connect(new FakeSocket())).not.toBeNull();
    }
    expect(arena.connect(new FakeSocket())).toBeNull();
    expect(arena.connectionCount).toBe(LIMITS.maxConnections);
  });

  it('recycles player ids of departed players (u16 wire bound)', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'a');
    arena.tick(TICK_DT_SEC);
    arena.disconnect(a.id);
    arena.tick(TICK_DT_SEC); // leave processed, sim player gone
    const socket = new FakeSocket();
    expect(arena.connect(socket)).toBe(a.id);
  });

  it('an intent only ever steers the socket-own player', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'a');
    const b = joinedPlayer(arena, 'b');
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(a.id, encodeInput([{ seq: 1, turn: 1 }], 0));
    arena.tick(TICK_DT_SEC);
    const snapshot = a.socket.lastSnapshot();
    expect(snapshot.players.find((p) => p.id === a.id)?.turn).toBe(1);
    expect(snapshot.players.find((p) => p.id === b.id)?.turn).toBe(0);
  });
});

describe('territory sync (ticket 04, spec §6.1: fill is server-only)', () => {
  /** Steer intents paced one per tick, like a real client. */
  function drive(arena: ArenaCore, socket: FakeSocket, id: number, turns: (-1 | 0 | 1)[]): void {
    for (const turn of turns) {
      const tick = socket.lastSnapshot().tick;
      arena.handleFrame(id, encodeInput([{ seq: tick, turn }], 0));
      arena.tick(TICK_DT_SEC);
    }
  }

  /** Out-and-back: straight out, over-rotate past 180°, straight home. */
  const loopManeuver = (): (-1 | 0 | 1)[] => [
    ...Array.from({ length: 12 }, (): 0 => 0),
    ...Array.from({ length: 12 }, (): 1 => 1),
    ...Array.from({ length: 40 }, (): 0 => 0),
  ];

  it('broadcasts a spawned player’s start block to everyone', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'a');
    arena.tick(TICK_DT_SEC);
    const b = joinedPlayer(arena, 'b');
    arena.tick(TICK_DT_SEC);
    for (const socket of [a.socket, b.socket]) {
      const sync = socket
        .decoded()
        .find((m) => m.type === 'territory' && m.playerId === b.id && m.reason === 'sync');
      expect(sync).toBeDefined();
      if (sync?.type !== 'territory') throw new Error('unreachable');
      expect(sync.territory.length).toBeGreaterThan(0);
    }
  });

  it('sends a joiner every existing territory and active trail, then deltas only', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'runner');
    arena.tick(TICK_DT_SEC);
    // Drive a straight out of its block so a real trail exists.
    drive(
      arena,
      a.socket,
      a.id,
      Array.from({ length: 14 }, (): 0 => 0),
    );
    const b = joinedPlayer(arena, 'late');
    const synced = b.socket.decoded();
    const territory = synced.find((m) => m.type === 'territory' && m.playerId === a.id);
    expect(territory).toBeDefined();
    const trail = synced.find((m) => m.type === 'trail' && m.playerId === a.id);
    if (trail?.type !== 'trail') throw new Error('joiner got no trail sync');
    expect(trail.points.length).toBeGreaterThanOrEqual(2);
  });

  it('a closed loop broadcasts the grown territory as a fill delta to everyone', () => {
    const arena = new ArenaCore(20260721);
    const a = joinedPlayer(arena, 'painter');
    const witness = joinedPlayer(arena, 'witness');
    arena.tick(TICK_DT_SEC);
    drive(arena, a.socket, a.id, loopManeuver());
    for (const socket of [a.socket, witness.socket]) {
      const fill = socket
        .decoded()
        .find((m) => m.type === 'territory' && m.playerId === a.id && m.reason === 'fill');
      expect(fill).toBeDefined();
    }
  });
});

describe('death broadcast (ticket 05, spec §2.1)', () => {
  /** Steer intents paced one per tick, like a real client. */
  function drive(arena: ArenaCore, socket: FakeSocket, id: number, turns: (-1 | 0 | 1)[]): void {
    for (const turn of turns) {
      const tick = socket.lastSnapshot().tick;
      arena.handleFrame(id, encodeInput([{ seq: tick, turn }], 0));
      arena.tick(TICK_DT_SEC);
    }
  }

  /** Straight out of the block, then a held max-rate circle → self-cut. */
  const selfCutManeuver = (): (-1 | 0 | 1)[] => [
    ...Array.from({ length: 14 }, (): 0 => 0),
    ...Array.from({ length: 30 }, (): 1 => 1),
  ];

  it('broadcasts the death to everyone, then the respawn block as a sync', () => {
    const arena = new ArenaCore(20260721);
    const a = joinedPlayer(arena, 'circler');
    const witness = joinedPlayer(arena, 'witness');
    arena.tick(TICK_DT_SEC);
    drive(arena, a.socket, a.id, selfCutManeuver());
    for (const socket of [a.socket, witness.socket]) {
      const messages = socket.decoded();
      const deathAt = messages.findIndex((m) => m.type === 'death');
      expect(deathAt).toBeGreaterThanOrEqual(0);
      const death = messages[deathAt];
      if (death?.type !== 'death') throw new Error('unreachable');
      expect(death).toEqual({
        type: 'death',
        victimId: a.id,
        killerId: a.id,
        cause: 'trailCut',
      });
      // The respawn territory follows the death frame — a client that clears
      // the victim's state on death has the fresh block by snapshot time.
      const syncAfter = messages
        .slice(deathAt + 1)
        .find((m) => m.type === 'territory' && m.playerId === a.id && m.reason === 'sync');
      expect(syncAfter).toBeDefined();
    }
    // The victim respawned: still present in the following snapshot.
    expect(a.socket.lastSnapshot().players.map((p) => p.id)).toContain(a.id);
  });
});

describe('own-score frames (ticket 09, spec §2.5/§10.5)', () => {
  function scores(socket: FakeSocket): Extract<ServerMessage, { type: 'score' }>[] {
    return socket.decoded().filter((m) => m.type === 'score');
  }

  /** Steer intents paced one per tick, like a real client. */
  function drive(arena: ArenaCore, socket: FakeSocket, id: number, turns: (-1 | 0 | 1)[]): void {
    for (const turn of turns) {
      const tick = socket.lastSnapshot().tick;
      arena.handleFrame(id, encodeInput([{ seq: tick, turn }], 0));
      arena.tick(TICK_DT_SEC);
    }
  }

  it('sends the running life to its own pilot only, on the score cadence', () => {
    const arena = new ArenaCore(1);
    const ada = joinedPlayer(arena, 'Ada');
    const bo = joinedPlayer(arena, 'Bo');
    for (let i = 0; i < LIMITS.scoreIntervalTicks; i++) arena.tick(TICK_DT_SEC);

    const own = scores(ada.socket);
    expect(own).toHaveLength(1);
    const frame = own[0];
    if (!frame) throw new Error('no score frame');
    expect(frame.final).toBe(false);
    expect(frame.lifeTicks).toBe(LIMITS.scoreIntervalTicks);
    // The 6×6 start block of the 200 WU arena is 0,09 % of the map.
    expect(frame.peakPct).toBeCloseTo(0.09, 6);
    // One other human all along — and each pilot gets only its OWN frame.
    expect(frame.avgOtherHumans).toBe(1);
    expect(scores(bo.socket)).toEqual(own);
  });

  it('nothing between two cadence ticks, and nothing before the spawn', () => {
    const arena = new ArenaCore(1);
    const ada = joinedPlayer(arena, 'Ada');
    // Tick 1..(interval-1): joined, spawned, but off-cadence.
    for (let i = 0; i < LIMITS.scoreIntervalTicks - 1; i++) arena.tick(TICK_DT_SEC);
    expect(scores(ada.socket)).toHaveLength(0);
    // A socket that never joined gets no score frame even on the cadence.
    const lurker = new FakeSocket();
    expect(arena.connect(lurker)).not.toBeNull();
    arena.tick(TICK_DT_SEC);
    expect(scores(ada.socket)).toHaveLength(1);
    expect(scores(lurker)).toHaveLength(0);
  });

  it('closes the life on death: a final frame with the counters it died with', () => {
    const arena = new ArenaCore(20260721);
    const a = joinedPlayer(arena, 'circler');
    const witness = joinedPlayer(arena, 'witness');
    arena.tick(TICK_DT_SEC);
    // Straight out of the block, then a held max-rate circle → self-cut.
    drive(arena, a.socket, a.id, [
      ...Array.from({ length: 14 }, (): 0 => 0),
      ...Array.from({ length: 30 }, (): 1 => 1),
    ]);

    const messages = a.socket.decoded();
    const deathAt = messages.findIndex((m) => m.type === 'death');
    expect(deathAt).toBeGreaterThanOrEqual(0);
    // The final frame follows the death frame of the same tick, so a client
    // resets its running estimate before committing the closed life.
    const final = messages.slice(deathAt).find((m) => m.type === 'score' && m.final);
    if (final?.type !== 'score') throw new Error('no final score frame after the death');
    expect(final.lifeTicks).toBeGreaterThan(14);
    expect(final.peakPct).toBeCloseTo(0.09, 6);
    expect(final.avgOtherHumans).toBe(1);
    // Nobody else learns a foreign score (spec §2.5: it is personal).
    expect(scores(witness.socket).some((m) => m.final)).toBe(false);
    // The next life starts over: the first live frame after the death counts
    // a fresh, shorter life — the counters reset with the respawn.
    for (let i = 0; i < LIMITS.scoreIntervalTicks; i++) arena.tick(TICK_DT_SEC);
    const afterDeath = a.socket
      .decoded()
      .slice(deathAt)
      .find((m) => m.type === 'score' && !m.final);
    if (afterDeath?.type !== 'score') throw new Error('no live score frame after the death');
    expect(afterDeath.lifeTicks).toBeLessThan(final.lifeTicks);
    expect(afterDeath.lifeTicks).toBeLessThanOrEqual(LIMITS.scoreIntervalTicks);
  });
});

describe('steal broadcast (ticket 06, spec §2.2)', () => {
  /**
   * Random spawns sit ≥ 25 WU apart — no scripted drive can steal within a
   * unit test's patience. Poise the sim state directly instead (white-box,
   * same geometry as sim-core's steal tests): filler one step from re-entry
   * with the loop ring laid, victim parked on its block inside it.
   */
  function poise(arena: ArenaCore, fillerId: number, victimId: number, ring: Point[]): void {
    const { state } = arena as unknown as { state: SimState };
    const filler = state.players.find((p) => p.id === fillerId);
    const victim = state.players.find((p) => p.id === victimId);
    if (!filler || !victim) throw new Error('players not spawned');
    Object.assign(filler, { x: 100, y: 103.3, heading: (3 * Math.PI) / 2, turn: 0 });
    filler.territory = [
      [
        [
          [97, 97],
          [103, 97],
          [103, 103],
          [97, 103],
        ],
      ],
    ];
    filler.trail = ring.map(([x, y]): Point => [x, y]);
    Object.assign(victim, { x: 110, y: 110, heading: 0, turn: 0 });
    victim.territory = [
      [
        [
          [107, 107],
          [113, 107],
          [113, 113],
          [107, 113],
        ],
      ],
    ];
    victim.trail = [];
  }

  function freshPair(): {
    arena: ArenaCore;
    filler: { socket: FakeSocket; id: number };
    victim: { socket: FakeSocket; id: number };
  } {
    const arena = new ArenaCore(1);
    const filler = joinedPlayer(arena, 'filler');
    const victim = joinedPlayer(arena, 'victim');
    arena.tick(TICK_DT_SEC); // both spawned
    return { arena, filler, victim };
  }

  it('a partial steal broadcasts the shrunken territory as a sync before the fill', () => {
    const { arena, filler, victim } = freshPair();
    poise(arena, filler.id, victim.id, [
      [102, 100],
      [120, 100],
      [120, 109],
      [100, 109],
      [100, 103.3],
    ]);
    const seenBefore = victim.socket.sent.length;
    arena.tick(TICK_DT_SEC);
    const fresh = victim.socket.decoded().slice(seenBefore);
    expect(fresh.some((m) => m.type === 'death')).toBe(false);
    const syncAt = fresh.findIndex(
      (m) => m.type === 'territory' && m.playerId === victim.id && m.reason === 'sync',
    );
    const fillAt = fresh.findIndex(
      (m) => m.type === 'territory' && m.playerId === filler.id && m.reason === 'fill',
    );
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(fillAt).toBeGreaterThan(syncAt);
    const sync = fresh[syncAt];
    if (sync?.type !== 'territory') throw new Error('unreachable');
    // The block lost its enclosed southern strip: 36 − 12.
    expect(territoryArea(sync.territory)).toBeCloseTo(24, 4);
  });

  it('a total loss broadcasts one death, then one respawn sync — never a duplicate', () => {
    const { arena, filler, victim } = freshPair();
    poise(arena, filler.id, victim.id, [
      [102, 100],
      [120, 100],
      [120, 120],
      [100, 120],
      [100, 103.3],
    ]);
    const seenBefore = filler.socket.sent.length;
    arena.tick(TICK_DT_SEC);
    const fresh = filler.socket.decoded().slice(seenBefore);
    const deathAt = fresh.findIndex((m) => m.type === 'death');
    expect(deathAt).toBeGreaterThanOrEqual(0);
    expect(fresh[deathAt]).toEqual({
      type: 'death',
      victimId: victim.id,
      killerId: filler.id,
      cause: 'totalLoss',
    });
    const victimSyncs = fresh.filter(
      (m) => m.type === 'territory' && m.playerId === victim.id && m.reason === 'sync',
    );
    expect(victimSyncs).toHaveLength(1);
    const sync = victimSyncs[0];
    if (sync?.type !== 'territory') throw new Error('unreachable');
    // The respawn block, not the wiped land.
    expect(territoryArea(sync.territory)).toBeCloseTo(BALANCE.spawn.startBlockWU ** 2, 4);
    expect(fresh.indexOf(sync)).toBeGreaterThan(deathAt);
  });
});

describe('same-tick join + disconnect', () => {
  it('cancels the unspawned join — no immortal ghost player', () => {
    const arena = new ArenaCore(1);
    const witness = joinedPlayer(arena, 'witness');
    arena.tick(TICK_DT_SEC);
    // Joins and vanishes before the next tick ever spawns it.
    const ghost = joinedPlayer(arena, 'ghost');
    arena.disconnect(ghost.id);
    arena.tick(TICK_DT_SEC);
    arena.tick(TICK_DT_SEC);
    expect(witness.socket.lastSnapshot().players.map((p) => p.id)).toEqual([witness.id]);
  });
});

describe('dead-socket sweep', () => {
  it('drops a connection that stops sending frames (half-open socket)', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'ghost');
    const b = joinedPlayer(arena, 'alive');
    for (let i = 0; i <= LIMITS.idleTimeoutTicks; i++) {
      arena.tick(TICK_DT_SEC);
      // Only b keeps talking, like a real client does every few ticks.
      arena.handleFrame(b.id, encodeInput([{ seq: i + 1, turn: 0 }], 0));
    }
    arena.tick(TICK_DT_SEC);
    expect(a.socket.closed).not.toBeNull();
    expect(b.socket.closed).toBeNull();
    expect(b.socket.lastSnapshot().players.map((p) => p.id)).toEqual([b.id]);
  });
});

describe('leave', () => {
  it('removes a disconnected player from the arena on the next tick', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'a');
    const b = joinedPlayer(arena, 'b');
    arena.tick(TICK_DT_SEC);
    arena.disconnect(a.id);
    arena.tick(TICK_DT_SEC);
    const snapshot = b.socket.lastSnapshot();
    expect(snapshot.players.map((p) => p.id)).toEqual([b.id]);
    expect(arena.connectionCount).toBe(1);
  });

  it('reports zero connections when everyone left (the DO stops ticking)', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena);
    arena.disconnect(a.id);
    expect(arena.connectionCount).toBe(0);
  });
});

describe('leaderboard broadcast (ticket 08, spec §2.5)', () => {
  /**
   * White-box (same pattern as the steal tests): give a player a square of
   * `edgeWU` centered on its head — land it owns without ever leaving it, so
   * the share under test cannot be disturbed by trails, fills or deaths.
   */
  function ownSquare(arena: ArenaCore, id: number, edgeWU: number): void {
    const { state } = arena as unknown as { state: SimState };
    const p = state.players.find((q) => q.id === id);
    if (!p) throw new Error('player not spawned');
    const half = edgeWU / 2;
    p.territory = [
      [
        [
          [p.x - half, p.y - half],
          [p.x + half, p.y - half],
          [p.x + half, p.y + half],
          [p.x - half, p.y + half],
        ],
      ],
    ];
  }

  function runTicks(arena: ArenaCore, ticks: number): void {
    for (let i = 0; i < ticks; i++) arena.tick(TICK_DT_SEC);
  }

  function boards(socket: FakeSocket): Extract<ServerMessage, { type: 'leaderboard' }>[] {
    return socket.decoded().filter((m) => m.type === 'leaderboard');
  }

  function lastBoard(socket: FakeSocket): Extract<ServerMessage, { type: 'leaderboard' }> {
    const all = boards(socket);
    const last = all[all.length - 1];
    if (!last) throw new Error('no leaderboard received');
    return last;
  }

  /** Joined, spawned players, ready to have their land poised. */
  function arenaOf(names: readonly string[]): {
    arena: ArenaCore;
    players: { socket: FakeSocket; id: number }[];
  } {
    const arena = new ArenaCore(1);
    const players = names.map((name) => joinedPlayer(arena, name));
    arena.tick(TICK_DT_SEC);
    return { arena, players };
  }

  it('ranks the arena by share of the map, biggest first, with names and percent', () => {
    const { arena, players } = arenaOf(['Ada', 'Bo']);
    const [ada, bo] = players;
    if (!ada || !bo) throw new Error('players missing');
    // 200 × 200 WU arena: a 20 WU square is 1 %, a 40 WU square 4 %.
    ownSquare(arena, ada.id, 20);
    ownSquare(arena, bo.id, 40);
    runTicks(arena, LIMITS.leaderboardIntervalTicks);
    expect(lastBoard(ada.socket).rows).toEqual([
      { rank: 1, playerId: bo.id, areaPct: 4, name: 'Bo' },
      { rank: 2, playerId: ada.id, areaPct: 1, name: 'Ada' },
    ]);
    // Everyone sees the same global ranking (spec §2.5).
    expect(lastBoard(bo.socket).rows).toEqual(lastBoard(ada.socket).rows);
  });

  it('appends the own row for a player ranked below the top five', () => {
    const names = Array.from({ length: 7 }, (_, i) => `P${String(i + 1)}`);
    const { arena, players } = arenaOf(names);
    // Strictly growing squares: the first player is last, the last is first.
    players.forEach((p, i) => {
      ownSquare(arena, p.id, 10 + 2 * i);
    });
    runTicks(arena, LIMITS.leaderboardIntervalTicks);

    const trailing = players[0];
    const leader = players[6];
    if (!trailing || !leader) throw new Error('players missing');
    const board = lastBoard(trailing.socket);
    expect(board.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(board.rows.map((r) => r.playerId).slice(0, 5)).toEqual(
      players
        .slice(2)
        .reverse()
        .map((p) => p.id),
    );
    expect(board.rows[5]).toMatchObject({ rank: 7, playerId: trailing.id, name: 'P1' });
    // A player already in the top five gets no appended duplicate.
    const leaderBoard = lastBoard(leader.socket);
    expect(leaderBoard.rows).toHaveLength(BALANCE.leaderboard.topN);
    expect(leaderBoard.rows[0]).toMatchObject({ rank: 1, playerId: leader.id });
  });

  it('stays silent while no share changed — no standing per-tick overhead', () => {
    const { arena, players } = arenaOf(['Ada', 'Bo']);
    const [ada] = players;
    if (!ada) throw new Error('player missing');
    runTicks(arena, LIMITS.leaderboardIntervalTicks);
    const seen = boards(ada.socket).length;
    expect(seen).toBeGreaterThan(0);
    runTicks(arena, 4 * LIMITS.leaderboardIntervalTicks);
    expect(boards(ada.socket)).toHaveLength(seen);
  });

  it('drops a player who left from the board', () => {
    const { arena, players } = arenaOf(['Ada', 'Bo']);
    const [ada, bo] = players;
    if (!ada || !bo) throw new Error('players missing');
    runTicks(arena, LIMITS.leaderboardIntervalTicks);
    expect(lastBoard(ada.socket).rows).toHaveLength(2);
    arena.disconnect(bo.id);
    runTicks(arena, LIMITS.leaderboardIntervalTicks);
    expect(lastBoard(ada.socket).rows.map((r) => r.playerId)).toEqual([ada.id]);
  });

  it('gives a blank join name the numbered auto-guest name (spec §2.8)', () => {
    const { arena, players } = arenaOf(['   ']);
    const [guest] = players;
    if (!guest) throw new Error('player missing');
    runTicks(arena, LIMITS.leaderboardIntervalTicks);
    // Not a blank row, and not one shared "Gast" for everyone either.
    expect(lastBoard(guest.socket).rows[0]?.name).toBe(`Gast-${String(guest.id).padStart(4, '0')}`);
  });

  it('never sends the board to a socket that has not joined (spec §8.2)', () => {
    const { arena } = arenaOf(['Ada']);
    const lurker = new FakeSocket();
    arena.connect(lurker);
    runTicks(arena, 2 * LIMITS.leaderboardIntervalTicks);
    expect(boards(lurker)).toHaveLength(0);
  });
});

describe('rewind view tracking (ticket 07)', () => {
  /** White-box peek at the sim (same pattern as the steal tests above). */
  function simPlayer(arena: ArenaCore, id: number): { viewDelayTicks: number } {
    const { state } = arena as unknown as { state: SimState };
    const p = state.players.find((q) => q.id === id);
    if (!p) throw new Error('player not spawned');
    return p;
  }

  it('derives the rewind depth from the reported view tick and hands it to the sim', () => {
    const arena = new ArenaCore(1);
    const { id } = joinedPlayer(arena);
    for (let i = 0; i < 6; i++) arena.tick(TICK_DT_SEC); // server tick = 6
    // Anchor frame: seq 1 applies at tick 7; the pilot reports rendering
    // opponents at tick 3 → their actions must be judged 4 ticks back.
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 3));
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(4);
    // No further frames: the delay persists in the sim like a held turn.
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(4);
  });

  it('grants a fast link only the interpolation allowance, however old a view it claims', () => {
    const arena = new ArenaCore(1);
    const { id } = joinedPlayer(arena);
    for (let i = 0; i < 6; i++) arena.tick(TICK_DT_SEC);
    // Seq 7 arriving at tick 6 is a tight timeline (tickOffset 0): this
    // client's inputs travel instantly, so it cannot honestly be rendering
    // ancient opponents. Claiming tick 1 buys the interpolation allowance,
    // not the 6 ticks it asked for — deep unlag has to be paid for with
    // genuinely late inputs.
    arena.handleFrame(id, encodeInput([{ seq: 7, turn: 0 }], 1));
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(LIMITS.rewindInterpAllowanceTicks);
  });

  it('caps even a genuinely late timeline at the rewind window', () => {
    const arena = new ArenaCore(1);
    const { id } = joinedPlayer(arena);
    for (let i = 0; i < 30; i++) arena.tick(TICK_DT_SEC);
    // Seq 1 arriving at tick 30 IS a 30-tick-late timeline — this client
    // pays for its unlag with that much steering delay — but the hard
    // window still caps what it gets (sv_maxunlag-style).
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 1));
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(LIMITS.rewindMaxTicks);
    // A view from the future rewinds nothing.
    arena.handleFrame(id, encodeInput([{ seq: 2, turn: 0 }], 9999));
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(0);
  });

  it('treats view tick 0 as "nothing rendered" — no rewind, and no frozen depth', () => {
    const arena = new ArenaCore(1);
    const { id } = joinedPlayer(arena);
    for (let i = 0; i < 6; i++) arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }], 3));
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(4);
    // Dropping back to 0 must not leave the earlier, deeper depth standing:
    // a client could otherwise claim a deep window once and then hold it by
    // never reporting a view again.
    arena.handleFrame(id, encodeInput([{ seq: 2, turn: 0 }], 0));
    arena.tick(TICK_DT_SEC);
    expect(simPlayer(arena, id).viewDelayTicks).toBe(0);
  });
});

describe('bot population (ticket 12, spec §2.7: bots = clamp(target − humans, 0, max))', () => {
  const { targetPopulation, maxBots } = BALANCE.bots;

  /** An arena configured like the public one: bots on, at the balanced target. */
  function populatedArena(): ArenaCore {
    return new ArenaCore(1, undefined, targetPopulation);
  }

  /** Everyone the sim holds, humans and bots alike (white-box, as above). */
  function simPlayers(arena: ArenaCore): { id: number; isBot: boolean }[] {
    const { state } = arena as unknown as { state: SimState };
    return state.players;
  }

  /** What a joined client actually SEES: the ids in its newest snapshot. */
  function seenIds(socket: FakeSocket): number[] {
    return socket.lastSnapshot().players.map((p) => p.id);
  }

  function runTicks(arena: ArenaCore, ticks: number): void {
    for (let i = 0; i < ticks; i++) arena.tick(TICK_DT_SEC);
  }

  it('fills a lone human’s arena up to the target population', () => {
    const arena = populatedArena();
    const ada = joinedPlayer(arena, 'Ada');
    // Bots join like anyone else: queued this tick, spawned on the next.
    runTicks(arena, 2);
    expect(seenIds(ada.socket)).toHaveLength(targetPopulation);
    const bots = simPlayers(arena).filter((p) => p.isBot);
    expect(bots).toHaveLength(targetPopulation - 1);
    // ...and they are marked as bots in the sim, which is what keeps them out
    // of everyone's score company (spec §10.5).
    expect(simPlayers(arena).find((p) => p.id === ada.id)?.isBot).toBe(false);
  });

  it('retires a bot for every human that arrives — humans first', () => {
    const arena = populatedArena();
    const humans = [joinedPlayer(arena, 'H1')];
    runTicks(arena, 2);
    expect(simPlayers(arena)).toHaveLength(targetPopulation);
    // Fill up to the target one human at a time; the population must stay put
    // and the bot share must shrink by exactly one each time.
    while (humans.length < targetPopulation) {
      humans.push(joinedPlayer(arena, `H${String(humans.length + 1)}`));
      runTicks(arena, 2);
      expect(simPlayers(arena), `${String(humans.length)} humans`).toHaveLength(targetPopulation);
      expect(simPlayers(arena).filter((p) => p.isBot)).toHaveLength(
        targetPopulation - humans.length,
      );
    }
    // Past the target, humans are simply added — bots never displace them and
    // never come back to compete for slots.
    humans.push(joinedPlayer(arena, 'extra'));
    runTicks(arena, 2);
    expect(simPlayers(arena).filter((p) => p.isBot)).toHaveLength(0);
    expect(simPlayers(arena)).toHaveLength(targetPopulation + 1);
  });

  it('never exceeds the bot ceiling, whatever the target asks for', () => {
    // A target beyond the ceiling (a mis-set override, a future private room):
    // `clamp(…, 0, maxBots)` is the binding half of the rule.
    const arena = new ArenaCore(1, undefined, maxBots + 5);
    joinedPlayer(arena, 'Ada');
    runTicks(arena, 2);
    expect(simPlayers(arena).filter((p) => p.isBot)).toHaveLength(maxBots);
  });

  it('keeps no bots without a human — the arena empties for hibernation', () => {
    const arena = populatedArena();
    const ada = joinedPlayer(arena, 'Ada');
    runTicks(arena, 2);
    expect(simPlayers(arena)).toHaveLength(targetPopulation);
    arena.disconnect(ada.id);
    runTicks(arena, 2);
    // 0 humans → 0 bots (spec §2.7): nothing left to tick, so the DO shell can
    // stop its ticker and hibernate at zero cost.
    expect(simPlayers(arena)).toHaveLength(0);
  });

  it('a connected socket that never joined is not a human — no bots for it', () => {
    const arena = populatedArena();
    const lurker = new FakeSocket();
    expect(arena.connect(lurker)).not.toBeNull();
    runTicks(arena, 3);
    expect(simPlayers(arena)).toHaveLength(0);
  });

  it('a bot never takes an id a human is using', () => {
    const arena = populatedArena();
    const ada = joinedPlayer(arena, 'Ada');
    runTicks(arena, 2);
    const ids = simPlayers(arena).map((p) => p.id);
    expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
    // A human joining now must still get a free id, not a bot's.
    const bo = joinedPlayer(arena, 'Bo');
    runTicks(arena, 2);
    expect(bo.id).not.toBe(ada.id);
    const after = simPlayers(arena).map((p) => p.id);
    expect(new Set(after).size).toBe(after.length);
    expect(after).toContain(bo.id);
  });

  it('grants no score company for bots — a lone human plays solo (spec §10.5)', () => {
    const arena = populatedArena();
    const ada = joinedPlayer(arena, 'Ada');
    runTicks(arena, LIMITS.scoreIntervalTicks);
    const score = ada.socket
      .decoded()
      .filter((m) => m.type === 'score')
      .at(-1);
    if (score?.type !== 'score') throw new Error('no score frame');
    // Seven bots alongside, and the multiplier still says "alone" — otherwise
    // an empty arena would be the cheapest place to farm one.
    expect(simPlayers(arena).filter((p) => p.isBot).length).toBeGreaterThan(0);
    expect(score.avgOtherHumans).toBe(0);
  });

  it('populates nothing unless a target was asked for (private rooms, tests)', () => {
    // The default is bots OFF: spec §10.4 gives private rooms exactly that, and
    // an arena under test must hold nobody the test did not put in it.
    const arena = new ArenaCore(1);
    joinedPlayer(arena, 'Ada');
    runTicks(arena, 3);
    expect(simPlayers(arena).filter((p) => p.isBot)).toHaveLength(0);
  });
});
