import { BALANCE, type Territory } from '@paintclash/shared';
import {
  decodeClientMessage,
  encodeSnapshot,
  encodeTerritory,
  encodeTrail,
  encodeWelcome,
  type SnapshotPlayer,
} from '@paintclash/protocol';
import { describe, expect, it } from 'vitest';

import { ClientSession, INPUT_FLUSH_TICKS } from './session.js';

function harness(): { session: ClientSession; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const session = new ClientSession((frame) => sent.push(frame), 'tester');
  return { session, sent };
}

function selfPlayer(overrides: Partial<SnapshotPlayer> = {}): SnapshotPlayer {
  return { id: 1, x: 100, y: 100, heading: 0, turn: 0, ...overrides };
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

function joined(session: ClientSession): void {
  session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
  session.receive(encodeTerritory(1, 'sync', blockAt(100, 100)));
  session.receive(encodeSnapshot(1, 0, [selfPlayer()]));
}

describe('handshake', () => {
  it('join() sends the join frame with the name', () => {
    const { session, sent } = harness();
    session.join();
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    expect(decodeClientMessage(frame)).toMatchObject({ type: 'join', name: 'tester' });
  });

  it('becomes ready once welcome + first snapshot arrived', () => {
    const { session } = harness();
    expect(session.ready()).toBe(false);
    joined(session);
    expect(session.ready()).toBe(true);
    expect(session.playerId).toBe(1);
  });
});

describe('sim ticks (input → prediction → batched send)', () => {
  it('flushes one batched input frame every INPUT_FLUSH_TICKS ticks', () => {
    const { session, sent } = harness();
    joined(session);
    sent.length = 0;
    // Steering straight (no direction change) exercises the pure cadence.
    for (let i = 0; i < INPUT_FLUSH_TICKS; i++) session.simTick(0);
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    const decoded = decodeClientMessage(frame);
    if (decoded?.type !== 'input') throw new Error('expected an input batch');
    expect(decoded.inputs).toHaveLength(INPUT_FLUSH_TICKS);
    expect(decoded.inputs[0]?.seq).toBe(1);
    expect(decoded.inputs.every((i) => i.turn === 0)).toBe(true);
  });

  it('flushes immediately when the steer direction changes (turn-onset latency)', () => {
    const { session, sent } = harness();
    joined(session);
    sent.length = 0;
    session.simTick(1); // direction change 0 → 1: flush now, not at tick 3
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (!frame) throw new Error('nothing sent');
    const decoded = decodeClientMessage(frame);
    if (decoded?.type !== 'input') throw new Error('expected an input batch');
    expect(decoded.inputs).toEqual([{ seq: 1, turn: 1 }]);
    // Holding the same direction returns to the batch cadence.
    session.simTick(1);
    session.simTick(1);
    expect(sent).toHaveLength(1);
    session.simTick(1);
    expect(sent).toHaveLength(2);
  });

  it('predicts the own head forward on every tick', () => {
    const { session } = harness();
    joined(session);
    session.simTick(0);
    const pose = session.renderSample(1);
    expect(pose.self?.x).toBeCloseTo(100.45, 5);
  });

  it('does nothing before the session is ready', () => {
    const { session, sent } = harness();
    session.simTick(1);
    expect(sent).toHaveLength(0);
    expect(session.renderSample(1).self).toBeNull();
  });
});

describe('snapshots feed reconciliation + interpolation', () => {
  it('reconciles the own player from the snapshot ack', () => {
    const { session } = harness();
    joined(session);
    session.simTick(0);
    session.simTick(0);
    // Server processed seq 1 → its self is one tick ahead of spawn.
    session.receive(encodeSnapshot(2, 1, [selfPlayer({ x: 100.45 })]));
    const pose = session.renderSample(1);
    // seq 2 replays on top: exactly two ticks from spawn (plus f32 wobble).
    expect(pose.self?.x).toBeCloseTo(100.9, 3);
  });

  it('exposes every synced territory with a revision that bumps per change', () => {
    const { session } = harness();
    expect(session.renderSample(1).territories).toEqual([]);
    joined(session);
    session.receive(encodeTerritory(2, 'sync', blockAt(50, 50)));
    session.receive(encodeSnapshot(2, 0, [selfPlayer(), selfPlayer({ id: 2, x: 50, y: 50 })]));
    let state = session.renderSample(1);
    expect(state.selfId).toBe(1);
    expect(state.territories.map((t) => t.playerId).sort()).toEqual([1, 2]);
    const before = state.territories.find((t) => t.playerId === 2)?.rev;
    session.receive(encodeTerritory(2, 'fill', blockAt(50, 50)));
    state = session.renderSample(1);
    const after = state.territories.find((t) => t.playerId === 2)?.rev;
    expect(after).toBe((before ?? 0) + 1);
  });

  it('reports growing fills once, for the wave animation', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeTerritory(2, 'sync', blockAt(50, 50)));
    expect(session.renderSample(1).fills).toEqual([]); // sync is no fill
    const grown: Territory = [[...(blockAt(50, 50)[0] ?? [])], [...(blockAt(70, 50)[0] ?? [])]];
    session.receive(encodeTerritory(2, 'fill', grown));
    expect(session.renderSample(1).fills).toEqual([2]);
    expect(session.renderSample(1).fills).toEqual([]); // drained
  });

  it('a discarded sliver fill clears the trail but earns no wave (spec §2.2 floor)', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeTerritory(2, 'sync', blockAt(50, 100)));
    // Enemy walks out of its block so a derived trail exists.
    for (let t = 2; t <= 6; t++) {
      const x = 50 + (t - 2) * 2;
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x, y: 100 })]));
      session.simTick(0);
    }
    expect(session.renderSample(0, 50).trails.some((t) => t.playerId === 2)).toBe(true);
    // The loop closes but captured nothing — territory unchanged.
    session.receive(encodeTerritory(2, 'fill', blockAt(50, 100)));
    const state = session.renderSample(0, 50);
    expect(state.fills).toEqual([]);
    expect(state.trails.some((t) => t.playerId === 2)).toBe(false);
  });

  it('drops territory and trails of players that left the arena', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeTerritory(9, 'sync', blockAt(50, 50)));
    session.receive(
      encodeTrail(9, [
        [40, 40],
        [41, 40],
      ]),
    );
    session.receive(encodeSnapshot(2, 0, [selfPlayer()])); // 9 is gone
    const state = session.renderSample(1);
    expect(state.territories.some((t) => t.playerId === 9)).toBe(false);
    expect(state.trails.some((t) => t.playerId === 9)).toBe(false);
  });

  it('grows the own trail from predicted ticks once outside, ends it on the fill', () => {
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    session.receive(encodeTerritory(1, 'sync', blockAt(100, 100)));
    // Spawn near the right edge, heading +x: outside after ~5 ticks.
    session.receive(encodeSnapshot(1, 0, [selfPlayer({ x: 101 })]));
    for (let i = 0; i < 8; i++) session.simTick(0);
    let trail = session.renderSample(1).trails.find((t) => t.playerId === 1);
    if (!trail) throw new Error('own trail missing');
    // Last point is the rendered head itself.
    const head = session.renderSample(1).self;
    expect(trail.points[trail.points.length - 1]?.[0]).toBeCloseTo(head?.x ?? NaN, 5);
    // The server's fill message ends the trail — never the local guess.
    session.receive(encodeTerritory(1, 'fill', blockAt(100, 100)));
    trail = session.renderSample(1).trails.find((t) => t.playerId === 1);
    expect(trail).toBeUndefined();
  });

  it('derives enemy trails from snapshot poses, held back to the render timeline', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeTerritory(2, 'sync', blockAt(50, 100)));
    // Enemy leaves its block heading +x: inside at 52, outside from 54.
    for (let t = 2; t <= 8; t++) {
      const x = 50 + (t - 2) * 2;
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x, y: 100 })]));
      session.simTick(0);
    }
    const state = session.renderSample(0, 50);
    const trail = state.trails.find((t) => t.playerId === 2);
    if (!trail) throw new Error('enemy trail missing');
    // Seeded with the last inside pose (52) …
    expect(trail.points[0]?.[0]).toBeCloseTo(52, 5);
    // … and its last point is the enemy's rendered (delayed) head.
    const enemy = state.others.find((o) => o.id === 2);
    expect(trail.points[trail.points.length - 1]?.[0]).toBeCloseTo(enemy?.x ?? NaN, 5);
    // The rendered head trails the newest snapshot (interp delay) — and so
    // does the revealed trail.
    expect(enemy?.x ?? NaN).toBeLessThan(62);
  });

  it('adopts a full trail sync for players already on their way (late join)', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeTerritory(2, 'sync', blockAt(50, 100)));
    session.receive(
      encodeTrail(2, [
        [53, 100],
        [60, 100],
        [60, 106],
      ]),
    );
    session.receive(encodeSnapshot(2, 0, [selfPlayer(), selfPlayer({ id: 2, x: 60, y: 107 })]));
    const trail = session.renderSample(1).trails.find((t) => t.playerId === 2);
    if (!trail) throw new Error('synced trail missing');
    // All synced points render immediately, head appended.
    expect(trail.points.length).toBeGreaterThanOrEqual(4);
    expect(trail.points[0]).toEqual([53, 100]);
  });

  it('exposes other players at an interpolation delay', () => {
    const { session } = harness();
    joined(session);
    session.receive(encodeSnapshot(2, 0, [selfPlayer(), selfPlayer({ id: 2, x: 50 })]));
    session.receive(encodeSnapshot(3, 0, [selfPlayer(), selfPlayer({ id: 2, x: 51 })]));
    const pose = session.renderSample(1);
    const other = pose.others.find((o) => o.id === 2);
    expect(other).toBeDefined();
    expect(other?.x).toBeLessThanOrEqual(51);
    // Never the own player among the others.
    expect(pose.others.some((o) => o.id === 1)).toBe(false);
  });

  it('keeps enemies moving on the local clock even when no snapshot arrives', () => {
    // The enemy timeline must NOT be driven by snapshot arrival — network
    // jitter would become visible time jumps. It advances with simTick.
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    session.receive(encodeSnapshot(1, 0, [selfPlayer(), selfPlayer({ id: 2, x: 49 })]));
    session.receive(encodeSnapshot(2, 0, [selfPlayer(), selfPlayer({ id: 2, x: 50 })]));
    session.receive(encodeSnapshot(3, 0, [selfPlayer(), selfPlayer({ id: 2, x: 51 })]));
    const positions: number[] = [];
    for (let i = 0; i < 4; i++) {
      const other = session.renderSample(0).others.find((o) => o.id === 2);
      if (other) positions.push(other.x);
      session.simTick(0); // local clock advances, no new snapshots
    }
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      if (prev === undefined || curr === undefined) throw new Error('missing sample');
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
    // It really moved somewhere within the buffered range.
    expect(positions[positions.length - 1]).toBeGreaterThan(positions[0] ?? Infinity);
    expect(positions[positions.length - 1]).toBeLessThanOrEqual(51);
  });

  it('never teleports enemies on a hitch-sized clock jump — catches up rate-limited', () => {
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    // Enemy walks 1 WU per tick along x.
    for (let t = 1; t <= 3; t++) {
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x: 40 + t })]));
    }
    const before = session.renderSample(0).others.find((o) => o.id === 2);
    // Hitch: the next snapshots are 15 ticks ahead (≤ the snap threshold).
    for (let t = 18; t <= 20; t++) {
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x: 40 + t })]));
    }
    const after = session.renderSample(0, 50).others.find((o) => o.id === 2);
    if (!before || !after) throw new Error('enemy missing');
    // One 50-ms frame may advance the enemy timeline at most 2 ticks (2 WU
    // here) — never the whole 15-tick jump at once.
    expect(after.x - before.x).toBeLessThanOrEqual(2.001);
    // And it does keep catching up over subsequent frames.
    let previous = after.x;
    for (let i = 0; i < 20; i++) {
      const next = session.renderSample(0, 50).others.find((o) => o.id === 2);
      if (!next) throw new Error('enemy vanished');
      expect(next.x - previous).toBeLessThanOrEqual(2.001);
      previous = next.x;
    }
    expect(previous).toBeGreaterThan(54); // arrived near the new timeline
  });

  it('a catch-up burst of own ticks glides instead of leaping on screen', () => {
    const { session } = harness();
    joined(session);
    session.simTick(0);
    const before = session.renderSample(1, 0);
    // Post-stall: 10 ticks in one frame, key held (worst case for heading).
    session.advance(1, 10);
    const after = session.renderSample(1, 0);
    if (!before.self || !after.self) throw new Error('missing self');
    // Rendered pose stays continuous at the burst instant …
    expect(Math.hypot(after.self.x - before.self.x, after.self.y - before.self.y)).toBeLessThan(
      0.1,
    );
    // … although the underlying prediction advanced 10 turning ticks
    // (the turn arc shows up on the y axis) — the glide brings it in.
    let sampled = after;
    for (let i = 0; i < 30; i++) {
      session.frame(50);
      sampled = session.renderSample(1, 50);
    }
    expect(Math.abs((sampled.self?.y ?? 0) - before.self.y)).toBeGreaterThan(0.5);
  });

  it('adapts the interpolation delay when snapshot delivery starves the clock', () => {
    const { session } = harness();
    session.receive(encodeWelcome(1, BALANCE.arena.sizeWU));
    const feed = (t: number): void => {
      session.receive(encodeSnapshot(t, 0, [selfPlayer(), selfPlayer({ id: 2, x: t })]));
    };
    // Smooth phase: snapshots and local ticks advance in lockstep.
    for (let t = 1; t <= 10; t++) {
      feed(t);
      session.simTick(0);
      session.renderSample(0, 50);
    }
    const newestBefore = 10;
    const renderedBefore = session.renderSample(0, 50).others.find((o) => o.id === 2)?.x ?? NaN;
    const gapBefore = newestBefore - renderedBefore;
    // Starvation burst: the local clock keeps running, snapshots stop. Many
    // starved frames in a row must count as ONE event (growth cooldown) —
    // otherwise a single hiccup slams the delay to its maximum.
    for (let i = 0; i < 8; i++) {
      session.simTick(0);
      session.renderSample(0, 50);
    }
    // Delivery resumes; later a second, separate burst gap occurs.
    for (let t = 11; t <= 40; t++) {
      feed(t);
      session.simTick(0);
      session.renderSample(0, 50);
    }
    for (let i = 0; i < 8; i++) {
      session.simTick(0);
      session.renderSample(0, 50);
    }
    for (let t = 41; t <= 90; t++) {
      feed(t);
      session.simTick(0);
      session.renderSample(0, 50);
    }
    const renderedAfter = session.renderSample(0, 50).others.find((o) => o.id === 2)?.x ?? NaN;
    const gapAfter = 90 - renderedAfter;
    // Two events → roughly two extra ticks of headroom; a per-frame growth
    // bug would have produced far more (capped at +6 after one burst).
    expect(gapAfter).toBeGreaterThan(gapBefore + 1);
    expect(gapAfter).toBeLessThan(gapBefore + 4.5);
  });

  it('ignores malformed server frames', () => {
    const { session } = harness();
    joined(session);
    expect(() => {
      session.receive(new Uint8Array([0xba, 0xad, 0xf0, 0x0d]));
    }).not.toThrow();
    expect(session.ready()).toBe(true);
  });
});

describe('sim cadence servos to the server tick rate', () => {
  // The production DO's Date.now() is self-consistent with its own timers
  // but can run off real time (measured: 22.2 Hz instead of 20). The input
  // timeline (seq ≡ client tick, ticket 17) only stays mapped if the client
  // produces seqs at the SERVER's real rate — so the sim cadence steers the
  // server-offset back to its baseline instead of assuming 20 Hz wall time.

  it('ticks at the nominal interval while both timelines advance in lockstep', () => {
    const { session } = harness();
    joined(session);
    for (let t = 2; t <= 30; t++) {
      session.simTick(0);
      session.receive(encodeSnapshot(t, 0, [selfPlayer()]));
    }
    expect(session.simIntervalMs()).toBeCloseTo(50, 5);
  });

  it('shortens the interval when the server outpaces the local clock', () => {
    const { session } = harness();
    joined(session);
    // Server advances 10% faster than the local tick (the measured skew).
    let t = 1;
    for (let i = 1; i <= 80; i++) {
      if (i % 10 !== 0) session.simTick(0);
      session.receive(encodeSnapshot(++t, 0, [selfPlayer()]));
    }
    expect(session.simIntervalMs()).toBeLessThan(48);
    expect(session.simIntervalMs()).toBeGreaterThanOrEqual(50 / 1.15 - 1e-9);
  });

  it('lengthens the interval when the server runs behind the local clock', () => {
    const { session } = harness();
    joined(session);
    // Local clock 10% faster than the server: two local ticks every 9th frame.
    let t = 1;
    for (let i = 1; i <= 80; i++) {
      session.simTick(0);
      if (i % 9 === 0) session.simTick(0);
      session.receive(encodeSnapshot(++t, 0, [selfPlayer()]));
    }
    expect(session.simIntervalMs()).toBeGreaterThan(52);
    expect(session.simIntervalMs()).toBeLessThanOrEqual(50 / 0.85 + 1e-9);
  });

  it('caps the rate adjustment, however large the standing offset error', () => {
    const { session } = harness();
    joined(session);
    // A sudden sub-resync offset shift of 8 ticks, then lockstep again: the
    // error saturates the clamp instead of scaling the rate without bound.
    let t = 1;
    session.receive(encodeSnapshot((t += 9), 0, [selfPlayer()]));
    for (let i = 0; i < 120; i++) {
      session.simTick(0);
      session.receive(encodeSnapshot(++t, 0, [selfPlayer()]));
    }
    expect(session.simIntervalMs()).toBeCloseTo(50 / 1.15, 1);
  });

  it('re-baselines after a hard clock resync instead of chasing the jump', () => {
    const { session } = harness();
    joined(session);
    for (let t = 2; t <= 10; t++) {
      session.simTick(0);
      session.receive(encodeSnapshot(t, 0, [selfPlayer()]));
    }
    // A clock break far beyond jitter (hidden tab, arena reset): adopt it.
    session.receive(encodeSnapshot(40, 0, [selfPlayer()]));
    expect(session.simIntervalMs()).toBeCloseTo(50, 5);
  });
});
