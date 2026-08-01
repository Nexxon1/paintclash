import { LIMITS } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import {
  chargeIp,
  GATE_BUCKETS,
  GATE_SWEEP_MS,
  gateWindowExpired,
  gateWindowKey,
  type GateBucket,
  type GateWindow,
} from './room-gate.js';

/** The two budgets, so every rule below is asserted against both (§8.3 3 + 6). */
const BUCKETS: { bucket: GateBucket; budget: number; windowMs: number }[] = [
  { bucket: 'create', budget: LIMITS.roomCreatePerIp, windowMs: LIMITS.roomCreateWindowMs },
  { bucket: 'join', budget: LIMITS.joinPerIp, windowMs: LIMITS.joinWindowMs },
];

describe.each(BUCKETS)('per-IP budget: $bucket (spec §8.3)', ({ bucket, budget, windowMs }) => {
  it('opens a fresh window on first contact', () => {
    const verdict = chargeIp(bucket, undefined, 1_000);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window).toEqual({ startedMs: 1_000, count: 1 });
  });

  it('spends exactly the budget, then refuses', () => {
    let window: GateWindow | undefined;
    for (let attempt = 1; attempt <= budget; attempt++) {
      const verdict = chargeIp(bucket, window, 1_000);
      expect(verdict.allowed, `attempt ${String(attempt)} of ${String(budget)}`).toBe(true);
      expect(verdict.window.count).toBe(attempt);
      window = verdict.window;
    }
    const refused = chargeIp(bucket, window, 1_000);
    expect(refused.allowed).toBe(false);
    expect(refused.window.count).toBe(budget);
  });

  it('does NOT extend the window on a refusal', () => {
    // A fixed window, deliberately: if a refused attempt pushed the window
    // forward, a client hammering the endpoint would never be let back in —
    // and the one hammering hardest would be locked out longest, which is a
    // denial of service the limiter would be performing on itself.
    const spent = { startedMs: 1_000, count: budget };
    const first = chargeIp(bucket, spent, 1_500);
    const later = chargeIp(bucket, first.window, 1_900);
    expect(later.window.startedMs).toBe(1_000);
    expect(chargeIp(bucket, later.window, 1_000 + windowMs).allowed).toBe(true);
  });

  it('tells a refused caller when the budget refills', () => {
    const spent = { startedMs: 10_000, count: budget };
    // 10 s into the window ⇒ the rest of it left.
    expect(chargeIp(bucket, spent, 20_000).retryAfterSec).toBe((windowMs - 10_000) / 1_000);
    // Never zero while refused: a "retry now" that is refused again is a lie.
    expect(chargeIp(bucket, spent, 10_000 + windowMs - 1).retryAfterSec).toBe(1);
  });

  it('starts a new window once the old one has run out', () => {
    const spent = { startedMs: 1_000, count: budget };
    const verdict = chargeIp(bucket, spent, 1_000 + windowMs);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window).toEqual({ startedMs: 1_000 + windowMs, count: 1 });
  });

  it('does not lock an address out over a clock that jumped backwards', () => {
    // The DO's clock is not a promise (see the tick-rate skew in `arena-do.ts`).
    // A window stamped in the future would otherwise refuse an address until
    // real time caught up with it.
    const future = { startedMs: 5_000_000, count: budget };
    const verdict = chargeIp(bucket, future, 1_000);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window).toEqual({ startedMs: 1_000, count: 1 });
  });

  it('reports a window as expired exactly when it no longer counts', () => {
    expect(gateWindowExpired(bucket, { startedMs: 1_000, count: 1 }, 1_000 + windowMs - 1)).toBe(
      false,
    );
    expect(gateWindowExpired(bucket, { startedMs: 1_000, count: 1 }, 1_000 + windowMs)).toBe(true);
    // Same guard as above: a future stamp is nonsense, so it is collectable.
    expect(gateWindowExpired(bucket, { startedMs: 5_000_000, count: 1 }, 1_000)).toBe(true);
  });

  it('namespaces the address so nothing else in storage can collide with it', () => {
    expect(gateWindowKey(bucket, '203.0.113.7')).toBe(`${bucket}:ip:203.0.113.7`);
    // IPv6 and the unknown-address fallback are just strings — no parsing, so
    // nothing about them can make the key ambiguous.
    expect(gateWindowKey(bucket, '2001:db8::1')).toBe(`${bucket}:ip:2001:db8::1`);
  });
});

describe('the two budgets together', () => {
  it('keeps one address’s buckets apart', () => {
    // Same address, two actions: spending every room creation must not cost the
    // player the socket they open to play in the room they just made.
    const ip = '203.0.113.7';
    expect(gateWindowKey('create', ip)).not.toBe(gateWindowKey('join', ip));
    let creates: GateWindow | undefined;
    for (let i = 0; i < LIMITS.roomCreatePerIp; i++) {
      creates = chargeIp('create', creates, 1_000).window;
    }
    expect(chargeIp('create', creates, 1_000).allowed).toBe(false);
    expect(chargeIp('join', undefined, 1_000).allowed).toBe(true);
  });

  it('sweeps no earlier than the longest window it stores', () => {
    // A sweep that ran sooner would delete a record that still counts, which is
    // how a rate limit quietly stops limiting.
    for (const { windowMs } of BUCKETS) expect(GATE_SWEEP_MS).toBeGreaterThanOrEqual(windowMs);
    expect(GATE_BUCKETS).toEqual(BUCKETS.map((entry) => entry.bucket));
  });

  it('is generous enough for a group behind one address', () => {
    // Spec §8.3's "im Zweifel durchlassen": friends creating rooms and joining
    // them from one CGNAT/WLAN address must not trip a protection aimed at
    // scripts. A full arena's worth of players, each reconnecting a few times,
    // stays inside the join budget.
    expect(LIMITS.roomCreatePerIp).toBeGreaterThanOrEqual(3);
    expect(LIMITS.joinPerIp).toBeGreaterThanOrEqual(4 * LIMITS.maxConnectionsPerIp);
  });
});
