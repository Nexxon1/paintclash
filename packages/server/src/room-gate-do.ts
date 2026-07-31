/**
 * Room-gate DO shell — the storage behind the per-IP room-creation budget
 * (spec §8.3 point 6, ticket 14). Every rule lives in `room-gate.ts` (plain
 * node); there is deliberately no logic here, like `arena-do.ts`.
 *
 * ## Why a Durable Object, and why exactly one
 *
 * The router is stateless by design (ADR-0004), so a per-IP counter has to live
 * somewhere that survives between requests. One DO addressed by a fixed name
 * gives a single consistent counter without a second storage product: room
 * creation is rare (a handful a minute across the whole game), so serializing it
 * through one object costs nothing, and this object is the natural seam for the
 * other per-IP caps spec §8.3 point 3 asks for (ticket 15).
 *
 * Writes are the budget worth watching (ADR-0004: 100k row-writes/day on Free),
 * and there is exactly one per **allowed** creation. A refusal writes nothing —
 * the record it would store is the record already there — so hammering the
 * endpoint cannot spend the write budget it is being refused for.
 *
 * Storage stays bounded by one alarm per window that drops the records that no
 * longer count; it only re-arms while records remain, so a quiet game holds no
 * timer at all.
 */

import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '@paintclash/shared';

import {
  chargeRoomCreate,
  roomWindowExpired,
  roomWindowKey,
  type CreateWindow,
} from './room-gate.js';

import type { Env } from './router.js';

export class RoomGateDO extends DurableObject<Env> {
  /**
   * Charge one room creation to the address in `?ip=`. 200 = go ahead, 429 =
   * refused with a `Retry-After` — the shape the router forwards to the client.
   */
  override async fetch(request: Request): Promise<Response> {
    // The address comes from the router, which read it off `CF-Connecting-IP`
    // (spec §8.3 point 3). A DO is unreachable from outside the Worker, so
    // nothing a client sends can reach this parameter.
    const ip = new URL(request.url).searchParams.get('ip') ?? 'unknown';
    const key = roomWindowKey(ip);
    const nowMs = Date.now();
    const verdict = chargeRoomCreate(await this.ctx.storage.get<CreateWindow>(key), nowMs);
    if (verdict.allowed) {
      await this.ctx.storage.put(key, verdict.window);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(nowMs + LIMITS.roomCreateWindowMs);
      }
      return new Response(null, { status: 200 });
    }
    return new Response(null, {
      status: 429,
      headers: { 'Retry-After': String(verdict.retryAfterSec) },
    });
  }

  /** Drop the windows that no longer count; re-arm only while some remain. */
  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    const windows = await this.ctx.storage.list<CreateWindow>({ prefix: roomWindowKey('') });
    const stale = [...windows]
      .filter(([, window]) => roomWindowExpired(window, nowMs))
      .map(([key]) => key);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    if (windows.size > stale.length) {
      await this.ctx.storage.setAlarm(nowMs + LIMITS.roomCreateWindowMs);
    }
  }
}
