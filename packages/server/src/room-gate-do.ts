/**
 * Gate DO shell — the storage behind the per-IP budgets (spec §8.3 point 3 + 6,
 * tickets 14/15). Every rule lives in `room-gate.ts` (plain node); there is
 * deliberately no logic here, like `arena-do.ts`.
 *
 * The name is the room-creation budget it was born for (ticket 14). Since ticket
 * 15 it also holds the **join rate** per address, which is what its own comment
 * predicted: this object is the natural seam for the per-IP caps of §8.3 point 3.
 * The class keeps its name because renaming a Durable Object class costs a
 * migration on a live deployment, and the gain would be cosmetic.
 *
 * ## Why a Durable Object, and why exactly one
 *
 * The router is stateless by design (ADR-0004), so a per-IP counter has to live
 * somewhere that survives between requests. One DO addressed by a fixed name
 * gives a single consistent counter without a second storage product — and for
 * the join rate it has to be central for a second reason: brute-forcing room
 * codes addresses a DIFFERENT arena DO on every guess, so only a counter in
 * front of all of them can see the pattern at all.
 *
 * Every socket open therefore serializes through this one object. That is
 * affordable because it does no I/O for a refusal and one small write for an
 * allowed charge, while the events themselves are rare (a player opens one socket
 * per game). It is also self-limiting under abuse: the flood that would queue
 * here is the flood being refused.
 *
 * Writes are the budget worth watching (ADR-0004: 100k row-writes/day on Free),
 * and there is exactly one per **allowed** charge. A refusal writes nothing —
 * the record it would store is the record already there — so hammering the
 * endpoint cannot spend the write budget it is being refused for.
 *
 * Storage stays bounded by one alarm per window that drops the records that no
 * longer count; it only re-arms while records remain, so a quiet game holds no
 * timer at all.
 */

import { DurableObject } from 'cloudflare:workers';

import {
  chargeIp,
  GATE_BUCKETS,
  GATE_SWEEP_MS,
  gateWindowExpired,
  gateWindowKey,
  type GateBucket,
  type GateWindow,
} from './room-gate.js';

import { UNKNOWN_ADDRESS, type Env } from './router.js';

export class RoomGateDO extends DurableObject<Env> {
  /**
   * Charge one action in `?bucket=` to the address in `?ip=`. 200 = go ahead,
   * 429 = refused with a `Retry-After` — the shape the router forwards to the
   * client.
   */
  override async fetch(request: Request): Promise<Response> {
    // Both parameters come from the router, which read the address off
    // `CF-Connecting-IP` (spec §8.3 point 3). A DO is unreachable from outside
    // the Worker, so nothing a client sends can reach either of them.
    const params = new URL(request.url).searchParams;
    const bucket = this.bucketOf(params.get('bucket'));
    const ip = params.get('ip') ?? UNKNOWN_ADDRESS;
    const key = gateWindowKey(bucket, ip);
    const nowMs = Date.now();
    const verdict = chargeIp(bucket, await this.ctx.storage.get<GateWindow>(key), nowMs);
    if (verdict.allowed) {
      await this.ctx.storage.put(key, verdict.window);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(nowMs + GATE_SWEEP_MS);
      }
      return new Response(null, { status: 200 });
    }
    return new Response(null, {
      status: 429,
      headers: { 'Retry-After': String(verdict.retryAfterSec) },
    });
  }

  /**
   * The bucket a request names. An unknown one is charged as a `join` rather
   * than waved through: this is a router bug if it ever happens, and the safe
   * reading of "some action by this address" is to count it.
   */
  private bucketOf(raw: string | null): GateBucket {
    return GATE_BUCKETS.find((bucket) => bucket === raw) ?? 'join';
  }

  /** Drop the windows that no longer count; re-arm only while some remain. */
  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    const stale: string[] = [];
    let kept = 0;
    for (const [key, window] of await this.ctx.storage.list<GateWindow>()) {
      const bucket = GATE_BUCKETS.find((candidate) => key.startsWith(gateWindowKey(candidate, '')));
      // A key that belongs to no bucket is from an older key scheme (ticket 14
      // wrote `ip:<address>` before there were two budgets). Nothing will ever
      // read it again, so it is collected rather than kept forever — the claim
      // that this object's storage stays bounded has to hold across a rename too.
      if (!bucket || gateWindowExpired(bucket, window, nowMs)) stale.push(key);
      else kept += 1;
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    if (kept > 0) await this.ctx.storage.setAlarm(nowMs + GATE_SWEEP_MS);
  }
}
