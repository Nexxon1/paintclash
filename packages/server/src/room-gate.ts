/**
 * Room-creation budget per IP (spec §8.3 point 6, ticket 14) — the rule, free
 * of any Durable Object API so it is unit-testable in plain node (spec §9.1).
 * The shell that owns the storage is `room-gate-do.ts`.
 *
 * Why a rule of its own at all: creating a room is the only thing an anonymous
 * caller can do that costs before anyone plays a tick — a fresh Durable Object
 * plus a SQLite write each time (ADR-0004) — and it is also the cheap way to
 * probe the code space from the inside. Everything else a client may do is a
 * steer intent on a socket it already holds.
 *
 * A **fixed window** rather than a sliding one or a token bucket: it needs one
 * stored record per address and no timer, and its worst case is well understood
 * (up to `roomCreatePerIp` in a burst, then a wait). The protection is a brake,
 * not a queue — smoothing the rate would cost state we would rather not keep
 * about a player's address.
 */

import { LIMITS } from '@paintclash/shared';

/** One address's spend inside the current window. */
export interface CreateWindow {
  /** DO-clock ms the window opened at. */
  startedMs: number;
  /** Rooms created since then. */
  count: number;
}

export interface GateVerdict {
  allowed: boolean;
  /**
   * The record to store back. Only an ALLOWED verdict has anything new to store:
   * a refusal returns the record that is already there, so the caller writing it
   * again would be the one thing this limit exists to prevent — spending the
   * write budget of whoever is hammering it (see `room-gate-do.ts`).
   */
  window: CreateWindow;
  /** Whole seconds until the budget refills; 0 when the caller was allowed. */
  retryAfterSec: number;
}

/**
 * Has this window run out, so it neither counts against an address nor needs
 * keeping? A `startedMs` in the future counts as expired: the DO's clock is not
 * a promise (see the production tick-rate skew documented in `arena-do.ts`), and
 * a stamp ahead of now would otherwise refuse an address until real time caught
 * up with it — the one failure mode a protection must not have.
 */
export function roomWindowExpired(window: CreateWindow, nowMs: number): boolean {
  const age = nowMs - window.startedMs;
  return age < 0 || age >= LIMITS.roomCreateWindowMs;
}

/** Storage key for one address, namespaced so nothing else can collide with it. */
export function roomWindowKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * Charge one room creation to this address. Returns the verdict *and* the record
 * that should stand afterwards. A refusal leaves the window **unchanged** — if a
 * refused attempt pushed it forward, a client hammering the endpoint would never
 * be let back in, and the one hammering hardest would be locked out longest.
 */
export function chargeRoomCreate(window: CreateWindow | undefined, nowMs: number): GateVerdict {
  if (!window || roomWindowExpired(window, nowMs)) {
    return { allowed: true, window: { startedMs: nowMs, count: 1 }, retryAfterSec: 0 };
  }
  if (window.count < LIMITS.roomCreatePerIp) {
    return {
      allowed: true,
      window: { startedMs: window.startedMs, count: window.count + 1 },
      retryAfterSec: 0,
    };
  }
  const leftMs = window.startedMs + LIMITS.roomCreateWindowMs - nowMs;
  return {
    allowed: false,
    window,
    // Ceiled and never zero: a "retry now" that is refused again is a lie, and
    // the caller is a `Retry-After` header away from believing it.
    retryAfterSec: Math.max(1, Math.ceil(leftMs / 1000)),
  };
}
