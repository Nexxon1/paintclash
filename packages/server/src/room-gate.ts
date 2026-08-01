/**
 * The per-IP budgets (spec §8.3 point 3 + 6, tickets 14/15) — the rule, free of
 * any Durable Object API so it is unit-testable in plain node (spec §9.1). The
 * shell that owns the storage is `room-gate-do.ts`.
 *
 * Two things a caller may do cost the game something before anyone has played a
 * tick, and both are counted here per address:
 *
 * - **`create`** — a private room is a fresh Durable Object plus a SQLite write
 *   (ADR-0004), and creating rooms is also the cheap way to probe the code space
 *   from the inside.
 * - **`join`** — a socket open wakes the one public arena, or a room DO for a
 *   *guessed* code. Reconnect spam and code brute force are the same traffic
 *   from here, which is why one counter covers both (spec §8.3 point 3).
 *
 * Everything else a client may do is a steer intent on a socket it already
 * holds, and that is the frame budget's job (`flood.ts`).
 *
 * A **fixed window** rather than a sliding one or a token bucket: it needs one
 * stored record per address and bucket and no timer, and its worst case is well
 * understood (up to the budget in a burst, then a wait). The protection is a
 * brake, not a queue — smoothing the rate would cost state we would rather not
 * keep about a player's address.
 */

import { LIMITS } from '@paintclash/shared';

/** What is being charged to an address; each has its own budget and record. */
export type GateBucket = 'create' | 'join';

/** Every bucket, for the shell's storage sweep. */
export const GATE_BUCKETS: readonly GateBucket[] = ['create', 'join'];

const BUDGETS: Readonly<Record<GateBucket, { perWindow: number; windowMs: number }>> = {
  create: { perWindow: LIMITS.roomCreatePerIp, windowMs: LIMITS.roomCreateWindowMs },
  join: { perWindow: LIMITS.joinPerIp, windowMs: LIMITS.joinWindowMs },
};

/**
 * How long a swept record may linger. The longest window, because a record is
 * only collectable once its own window has run out.
 */
export const GATE_SWEEP_MS = Math.max(...GATE_BUCKETS.map((bucket) => BUDGETS[bucket].windowMs));

/** One address's spend inside the current window, for one bucket. */
export interface GateWindow {
  /** DO-clock ms the window opened at. */
  startedMs: number;
  /** Charges since then. */
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
  window: GateWindow;
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
export function gateWindowExpired(bucket: GateBucket, window: GateWindow, nowMs: number): boolean {
  const age = nowMs - window.startedMs;
  return age < 0 || age >= BUDGETS[bucket].windowMs;
}

/**
 * Storage key for one address in one bucket, namespaced twice: nothing else in
 * the object can collide with it, and the two budgets cannot be spent on each
 * other's behalf.
 */
export function gateWindowKey(bucket: GateBucket, ip: string): string {
  return `${bucket}:ip:${ip}`;
}

/**
 * Charge one action to this address. Returns the verdict *and* the record that
 * should stand afterwards. A refusal leaves the window **unchanged** — if a
 * refused attempt pushed it forward, a client hammering the endpoint would never
 * be let back in, and the one hammering hardest would be locked out longest.
 */
export function chargeIp(
  bucket: GateBucket,
  window: GateWindow | undefined,
  nowMs: number,
): GateVerdict {
  const budget = BUDGETS[bucket];
  if (!window || gateWindowExpired(bucket, window, nowMs)) {
    return { allowed: true, window: { startedMs: nowMs, count: 1 }, retryAfterSec: 0 };
  }
  if (window.count < budget.perWindow) {
    return {
      allowed: true,
      window: { startedMs: window.startedMs, count: window.count + 1 },
      retryAfterSec: 0,
    };
  }
  const leftMs = window.startedMs + budget.windowMs - nowMs;
  return {
    allowed: false,
    window,
    // Ceiled and never zero: a "retry now" that is refused again is a lie, and
    // the caller is a `Retry-After` header away from believing it.
    retryAfterSec: Math.max(1, Math.ceil(leftMs / 1000)),
  };
}
