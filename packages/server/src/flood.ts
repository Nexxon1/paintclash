/**
 * Per-connection frame budget (spec §8.3 point 2, ticket 15) — the rule, free of
 * any Durable Object API so it is unit-testable in plain node (spec §9.1). The
 * shell that holds one window per socket is `arena-do.ts`.
 *
 * Why the transport shell and not `ArenaCore`: this is the cheapest boundary in
 * the system. A frame charged here has not been decoded, not been looked up
 * against a player, not allocated anything — which is the whole point of a flood
 * limit, since the cost a flood inflicts on a single-threaded arena is exactly
 * the work done per frame. It also covers a socket that is not a player at all
 * (a private room's lobby), which `ArenaCore` never sees.
 *
 * The **fixed window** is the same shape as the room-creation budget
 * (`room-gate.ts`) and for the same reasons: one small record per socket, no
 * timer, and a worst case anyone can state (up to `framesPerWindow` in a burst,
 * then dropped). What it adds is a streak — a limiter that only ever dropped
 * would let a client flood forever for free, and one that killed on the first
 * excess frame would hang up on a client flushing a stall.
 *
 * The clock is the DO's `Date.now()`, which is not a promise (see the production
 * tick-rate skew documented in `arena-do.ts`). It does not have to be: a window
 * measured 10 % wide costs 10 % more headroom, and a clock that jumps backwards
 * opens a fresh window rather than muting a player.
 */

import { LIMITS } from '@paintclash/shared';

/** One socket's frame spend inside the current window. */
export interface FrameWindow {
  /** DO-clock ms the window opened at. */
  startedMs: number;
  /** Frames charged since then, surplus included. */
  frames: number;
  /** Consecutive windows that went over the budget. */
  floodWindows: number;
}

/**
 * What the caller does with the frame it just charged:
 * - `accept` — inside the budget, parse it;
 * - `drop` — surplus, discard it unparsed (the connection stays);
 * - `kill` — the flood has held for `floodKillWindows`, close the socket.
 */
export type FrameVerdict = 'accept' | 'drop' | 'kill';

export interface FloodVerdict {
  verdict: FrameVerdict;
  /** The window that stands afterwards — always, verdict regardless. */
  window: FrameWindow;
}

/** Has this window run out? A stamp in the future counts as expired (see above). */
function expired(window: FrameWindow, nowMs: number): boolean {
  const age = nowMs - window.startedMs;
  return age < 0 || age >= LIMITS.frameWindowMs;
}

/**
 * Charge one inbound frame to this socket. Unlike the room-creation budget, a
 * refusal DOES update the record: the surplus is what a flood consists of, so it
 * has to be counted for the streak to mean anything. The record is per socket
 * and in memory, so counting a refused frame costs nothing that could be spent.
 */
export function chargeFrame(window: FrameWindow | undefined, nowMs: number): FloodVerdict {
  if (!window || expired(window, nowMs)) {
    // A window that closes over budget carries its streak into the next one —
    // but only if this frame arrives in the window that FOLLOWS it. Consecutive
    // is the whole meaning of "anhaltend": two bursts a minute apart are two
    // bursts, and so are two bursts with a silence between them. Without the
    // adjacency test a backgrounded tab that flushes on every wake would collect
    // a kick out of bursts that never overlapped.
    const adjacent = window !== undefined && nowMs - window.startedMs < 2 * LIMITS.frameWindowMs;
    const kept = adjacent && window.frames > LIMITS.framesPerWindow ? window.floodWindows : 0;
    return { verdict: 'accept', window: { startedMs: nowMs, frames: 1, floodWindows: kept } };
  }
  const frames = window.frames + 1;
  if (frames <= LIMITS.framesPerWindow) {
    return { verdict: 'accept', window: { ...window, frames } };
  }
  // The FIRST excess frame is what makes this a flooding window; the ones after
  // it are the same window, already counted.
  const floodWindows =
    frames === LIMITS.framesPerWindow + 1 ? window.floodWindows + 1 : window.floodWindows;
  return {
    verdict: floodWindows >= LIMITS.floodKillWindows ? 'kill' : 'drop',
    window: { startedMs: window.startedMs, frames, floodWindows },
  };
}
