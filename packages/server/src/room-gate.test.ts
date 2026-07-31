import { LIMITS } from '@paintclash/shared';
import { describe, expect, it } from 'vitest';

import { chargeRoomCreate, roomWindowExpired, roomWindowKey } from './room-gate.js';

const WINDOW = LIMITS.roomCreateWindowMs;
const BUDGET = LIMITS.roomCreatePerIp;

describe('room-creation budget per IP (spec §8.3 point 6)', () => {
  it('opens a fresh window on first contact', () => {
    const verdict = chargeRoomCreate(undefined, 1_000);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window).toEqual({ startedMs: 1_000, count: 1 });
  });

  it('spends exactly the budget, then refuses', () => {
    let window = undefined as { startedMs: number; count: number } | undefined;
    for (let attempt = 1; attempt <= BUDGET; attempt++) {
      const verdict = chargeRoomCreate(window, 1_000);
      expect(verdict.allowed, `attempt ${String(attempt)} of ${String(BUDGET)}`).toBe(true);
      expect(verdict.window.count).toBe(attempt);
      window = verdict.window;
    }
    const refused = chargeRoomCreate(window, 1_000);
    expect(refused.allowed).toBe(false);
    expect(refused.window.count).toBe(BUDGET);
  });

  it('does NOT extend the window on a refusal', () => {
    // A fixed window, deliberately: if a refused attempt pushed the window
    // forward, a client hammering the endpoint would never be let back in —
    // and the one hammering hardest would be locked out longest, which is a
    // denial of service the limiter would be performing on itself.
    const spent = { startedMs: 1_000, count: BUDGET };
    const first = chargeRoomCreate(spent, 1_500);
    const later = chargeRoomCreate(first.window, 1_900);
    expect(later.window.startedMs).toBe(1_000);
    expect(chargeRoomCreate(later.window, 1_000 + WINDOW).allowed).toBe(true);
  });

  it('tells a refused caller when the budget refills', () => {
    const spent = { startedMs: 10_000, count: BUDGET };
    // 10 s into a 60 s window ⇒ 50 s left.
    expect(chargeRoomCreate(spent, 20_000).retryAfterSec).toBe((WINDOW - 10_000) / 1_000);
    // Never zero while refused: a "retry now" that is refused again is a lie.
    expect(chargeRoomCreate(spent, 10_000 + WINDOW - 1).retryAfterSec).toBe(1);
  });

  it('starts a new window once the old one has run out', () => {
    const spent = { startedMs: 1_000, count: BUDGET };
    const verdict = chargeRoomCreate(spent, 1_000 + WINDOW);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window).toEqual({ startedMs: 1_000 + WINDOW, count: 1 });
  });

  it('does not lock an address out over a clock that jumped backwards', () => {
    // The DO's clock is not a promise (see the tick-rate skew in `arena-do.ts`).
    // A window stamped in the future would otherwise refuse an address until
    // real time caught up with it.
    const future = { startedMs: 5_000_000, count: BUDGET };
    const verdict = chargeRoomCreate(future, 1_000);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window).toEqual({ startedMs: 1_000, count: 1 });
  });

  it('is generous enough for a group behind one address', () => {
    // Spec §8.3's "im Zweifel durchlassen": several friends creating rooms from
    // one CGNAT/WLAN address must not trip a protection aimed at scripts.
    expect(BUDGET).toBeGreaterThanOrEqual(3);
  });
});

describe('sweep', () => {
  it('reports a window as expired exactly when it no longer counts', () => {
    expect(roomWindowExpired({ startedMs: 1_000, count: 1 }, 1_000 + WINDOW - 1)).toBe(false);
    expect(roomWindowExpired({ startedMs: 1_000, count: 1 }, 1_000 + WINDOW)).toBe(true);
    // Same guard as above: a future stamp is nonsense, so it is collectable.
    expect(roomWindowExpired({ startedMs: 5_000_000, count: 1 }, 1_000)).toBe(true);
  });
});

describe('roomWindowKey', () => {
  it('namespaces the address so nothing else in storage can collide with it', () => {
    expect(roomWindowKey('203.0.113.7')).toBe('ip:203.0.113.7');
    // IPv6 and the unknown-address fallback are just strings — no parsing, so
    // nothing about them can make the key ambiguous.
    expect(roomWindowKey('2001:db8::1')).toBe('ip:2001:db8::1');
  });
});
