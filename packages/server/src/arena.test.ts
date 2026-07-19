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
  arena.handleFrame(id, encodeJoin(name));
  return { socket, id };
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

describe('authoritative movement', () => {
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

  it('applies a steer intent (after the jitter window) and echoes its seq as ack', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 5, turn: 1 }]));
    // A lone intent is held LIMITS.inputBufferTicks ticks (jitter buffer) …
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(0);
    // … then applied.
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(5);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
  });

  it('a full batch releases the jitter buffer immediately', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(
      id,
      encodeInput(
        Array.from({ length: LIMITS.inputBufferTicks }, (_, i) => ({
          seq: i + 1,
          turn: 1 as const,
        })),
      ),
    );
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().ackSeq).toBe(1);
  });

  it('replays a batched frame one intent per tick — a short tap is never lost', () => {
    // The client batches 3 ticks per frame (spec §6.3); the server must
    // reconstruct that timeline, not collapse it to the last turn.
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(
      id,
      encodeInput([
        { seq: 1, turn: 1 },
        { seq: 2, turn: 1 },
        { seq: 3, turn: 0 },
      ]),
    );
    arena.tick(TICK_DT_SEC);
    let snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(1);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
    arena.tick(TICK_DT_SEC);
    snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(2);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
    arena.tick(TICK_DT_SEC);
    snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(3);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(0);
  });

  it('drops the oldest backlog beyond the flood cap (spec §8.3)', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    const flood = Array.from({ length: LIMITS.maxPendingInputs + 4 }, (_, i) => ({
      seq: i + 1,
      turn: 1 as const,
    }));
    arena.handleFrame(id, encodeInput(flood.slice(0, 20)));
    arena.tick(TICK_DT_SEC);
    // The first applied intent is the oldest *surviving* one — everything
    // before it was dropped as flood.
    expect(socket.lastSnapshot().ackSeq).toBe(flood.length - LIMITS.maxPendingInputs + 1);
  });

  it('drops non-monotonic sequence numbers (server-limited, spec §6.4)', () => {
    const arena = new ArenaCore(1);
    const { socket, id } = joinedPlayer(arena);
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(id, encodeInput([{ seq: 10, turn: 1 }]));
    arena.tick(TICK_DT_SEC);
    arena.tick(TICK_DT_SEC); // jitter window over — seq 10 applied
    arena.handleFrame(id, encodeInput([{ seq: 3, turn: -1 }])); // replay/stale
    arena.tick(TICK_DT_SEC);
    arena.tick(TICK_DT_SEC);
    const snapshot = socket.lastSnapshot();
    expect(snapshot.ackSeq).toBe(10);
    expect(snapshot.players.find((p) => p.id === id)?.turn).toBe(1);
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

  it('ignores input frames from a connection that never joined', () => {
    const arena = new ArenaCore(1);
    const socket = new FakeSocket();
    const id = arena.connect(socket);
    arena.handleFrame(id, encodeInput([{ seq: 1, turn: 1 }]));
    arena.tick(TICK_DT_SEC);
    expect(socket.lastSnapshot().players).toHaveLength(0);
  });

  it('an intent only ever steers the socket-own player', () => {
    const arena = new ArenaCore(1);
    const a = joinedPlayer(arena, 'a');
    const b = joinedPlayer(arena, 'b');
    arena.tick(TICK_DT_SEC);
    arena.handleFrame(a.id, encodeInput([{ seq: 1, turn: 1 }]));
    arena.tick(TICK_DT_SEC);
    arena.tick(TICK_DT_SEC); // jitter window
    const snapshot = a.socket.lastSnapshot();
    expect(snapshot.players.find((p) => p.id === a.id)?.turn).toBe(1);
    expect(snapshot.players.find((p) => p.id === b.id)?.turn).toBe(0);
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
