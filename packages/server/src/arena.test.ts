import { BALANCE, LIMITS, TICK_DT_SEC } from '@paintclash/shared';
import {
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  type ServerMessage,
} from '@paintclash/protocol';
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
      encodeInput([
        { seq: 1, turn: 0 },
        { seq: 2, turn: 0 },
        { seq: 3, turn: 1 },
      ]),
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
      encodeInput([
        { seq: 1, turn: 0 },
        { seq: 2, turn: 0 },
        { seq: 3, turn: 1 },
      ]),
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
      encodeInput([
        { seq: 4, turn: -1 },
        { seq: 5, turn: -1 },
      ]),
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
      encodeInput([
        { seq: 1, turn: 0 },
        { seq: 2, turn: 0 },
        { seq: 3, turn: 0 },
      ]),
    );
    arena.tick(TICK_DT_SEC);
    const straight = socket.lastSnapshot();
    expect(straight.ackSeq).toBe(3);
    // Press: the real client flushes ON the change tick, so the change is
    // always the newest item of its frame.
    arena.handleFrame(id, encodeInput([{ seq: 4, turn: 1 }]));
    arena.tick(TICK_DT_SEC);
    const pressed = socket.lastSnapshot();
    expect(pressed.ackSeq).toBe(4);
    expect(pressed.players.find((p) => p.id === id)?.turn).toBe(1);
    // Release next tick.
    arena.handleFrame(id, encodeInput([{ seq: 5, turn: 0 }]));
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
      encodeInput([
        { seq: 1, turn: 1 },
        { seq: 2, turn: 1 },
        { seq: 3, turn: 1 },
      ]),
    );
    arena.tick(TICK_DT_SEC);
    // Four cadence rounds: each batch fully in flight before its ticks run.
    for (let round = 0; round < 4; round++) {
      const base = 4 + round * 3;
      const turn = round === 3 ? -1 : 1;
      arena.handleFrame(
        id,
        encodeInput([
          { seq: base, turn },
          { seq: base + 1, turn },
          { seq: base + 2, turn },
        ]),
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
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }]));
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(1);
    // Client stalls for 10 ticks; the server keeps simulating + acking.
    for (let i = 0; i < 10; i++) arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(11);
    const before = socket.lastSnapshot().players.find((p) => p.id === id);
    // The catch-up burst arrives late: only the seqs whose ticks are still
    // ahead survive; the head must advance ONE step, never a replayed dozen.
    const burst = Array.from({ length: 12 }, (_, i) => ({ seq: i + 2, turn: 1 as const }));
    arena.handleFrame(id, encodeInput(burst));
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
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }]));
    arena.tick(TICK_DT_SEC);
    const before = socket.lastSnapshot().players.find((p) => p.id === id);
    // Two frames of 20 far-future seqs — a hostile/broken timeline. The
    // second out-of-range frame re-anchors to the newest seq.
    arena.handleFrame(
      id,
      encodeInput(Array.from({ length: 20 }, (_, i) => ({ seq: i + 2, turn: 1 as const }))),
    );
    arena.handleFrame(
      id,
      encodeInput(Array.from({ length: 20 }, (_, i) => ({ seq: i + 22, turn: -1 as const }))),
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
    arena.handleFrame(id, encodeInput([{ seq: 10, turn: 1 }]));
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(10);
    arena.handleFrame(id, encodeInput([{ seq: 3, turn: -1 }])); // replay/stale
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
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }]));
    // Every frame arrives with zero margin: seq == just-run tick, mapped to
    // the very next tick. The smoothed margin sinks below the floor → the
    // mapping slackens by one tick, once.
    for (let i = 0; i < 30; i++) {
      arena.tick(TICK_DT_SEC);
      const tick = socket.lastSnapshot().tick;
      arena.handleFrame(id, encodeInput([{ seq: tick, turn: 1 }]));
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
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }]));
    for (let i = 0; i < 40; i++) {
      arena.tick(TICK_DT_SEC);
      const tick = socket.lastSnapshot().tick;
      // Three ticks of headroom on every frame — two of them are reclaimable.
      arena.handleFrame(id, encodeInput([{ seq: tick + 3, turn: 1 }]));
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
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }]));
    let seq = 1;
    for (let i = 0; i < 5; i++) {
      arena.tick(TICK_DT_SEC);
      arena.handleFrame(id, encodeInput([{ seq: ++seq, turn: 0 }]));
    }
    // Long client freeze: its clamped catch-up permanently trails the wall
    // clock, so every future seq would map into the already-acked past.
    for (let i = 0; i < 25; i++) arena.tick(TICK_DT_SEC);
    const ackAhead = socket.lastSnapshot().ackSeq;
    expect(ackAhead).toBeGreaterThan(seq);
    // Two consecutive out-of-range frames re-anchor; the second one already
    // steers again.
    arena.handleFrame(id, encodeInput([{ seq: ++seq, turn: -1 }]));
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: ++seq, turn: -1 }]));
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
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 0 }]));
    arena.handleFrame(id, new Uint8Array([0xba, 0xad]));
    expect(socket.closed).toBeNull();
  });

  it('sends nothing to a connection that never joined — no inputs, no snapshots', () => {
    const arena = new ArenaCore(1);
    const socket = new FakeSocket();
    const id = arena.connect(socket);
    if (id === null) throw new Error('arena unexpectedly full');
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 1 }]));
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
    arena.handleFrame(a.id, encodeInput([{ seq: 1, turn: 1 }]));
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
      arena.handleFrame(id, encodeInput([{ seq: tick, turn }]));
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
      arena.handleFrame(b.id, encodeInput([{ seq: i + 1, turn: 0 }]));
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
