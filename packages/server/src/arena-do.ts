/**
 * Arena-DO shell (ADR-0004: 1 DO = 1 arena): owns WebSockets and the 20 Hz
 * pacing, delegates every rule to the node-testable `ArenaCore`. Exercised
 * end-to-end by the scenario tests (`tests/scenario/`), not unit-tested —
 * there is deliberately no logic here.
 *
 * Uses the WebSocket Hibernation API: its `webSocketClose`/`webSocketError`
 * handlers are delivered reliably (the classic `addEventListener('close')`
 * path is not under `wrangler dev`, which left ghost players in the arena).
 * As a backstop, a failing `send` also drops the connection.
 *
 * Live state is memory-only (ADR-0004): an eviction resets the arena. The
 * ticker only runs while sockets exist — an empty arena costs nothing
 * (spec §7.2: "nur ticken, wenn ein Spiel mit Spielern läuft"). While the
 * ticker runs the DO cannot hibernate, so the in-memory arena and the
 * socket→player map never outlive each other.
 */

import { DurableObject } from 'cloudflare:workers';
import { TICK_DT_MS, TICK_DT_SEC } from '@paintclash/shared';

import { ArenaCore } from './arena.js';

export class ArenaDO extends DurableObject {
  private arena: ArenaCore | null = null;
  private readonly socketIds = new Map<WebSocket, number>();
  private ticking = false;

  override fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    this.arena ??= new ArenaCore(crypto.getRandomValues(new Uint32Array(1))[0] ?? 1);
    const arena = this.arena;
    const playerId = arena.connect({
      send: (frame) => {
        try {
          server.send(frame);
        } catch {
          // Socket died without a close event — drop the player.
          this.drop(server);
        }
      },
      close: (code, reason) => {
        try {
          server.close(code, reason);
        } catch {
          /* already closed */
        }
        // The arena killed this socket itself (idle/garbage) — don't wait
        // for a close event that a half-open connection may never deliver.
        this.drop(server);
      },
    });
    if (playerId === null) {
      server.close(1013, 'arena full'); // spec §8.3: clean rejection, no queue
      return new Response(null, { status: 101, webSocket: client });
    }
    this.socketIds.set(server, playerId);

    this.startTicker(arena);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const playerId = this.socketIds.get(ws);
    if (playerId === undefined || !this.arena) {
      // Socket from before an arena reset/eviction — force a clean rejoin.
      ws.close(1012, 'arena reset');
      return;
    }
    // Text frames are protocol violations — run them through the same
    // malformed-frame accounting as binary garbage (spec §8.3).
    const bytes = typeof message === 'string' ? new Uint8Array([0xff]) : new Uint8Array(message);
    this.arena.handleFrame(playerId, bytes);
  }

  override webSocketClose(ws: WebSocket): void {
    this.drop(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.drop(ws);
  }

  private drop(ws: WebSocket): void {
    const playerId = this.socketIds.get(ws);
    this.socketIds.delete(ws);
    if (playerId !== undefined) this.arena?.disconnect(playerId);
  }

  /**
   * Self-rescheduling 50 ms cadence against a fixed schedule; stops when
   * empty. After a runtime stall (GC, workerd hiccup — seconds under
   * `wrangler dev`) the schedule RE-ANCHORS instead of replaying the missed
   * ticks back-to-back: a burst of catch-up ticks broadcasts dozens of
   * snapshots at once, which every client can only render as a teleport.
   * Skipping the debt just pauses the world briefly — equally for everyone.
   *
   * KNOWN SKEW (measured 2026-07-21, ticket 17): in production the isolate's
   * Date.now() is self-consistent with its own timers but runs ~10% off real
   * time — this loop paces a perfect 50 ms by its own clock yet emits ~22
   * ticks per real second (locally: exactly 20). Undetectable from inside;
   * clients therefore servo their sim cadence to the OBSERVED tick rate
   * (ClientSession.simIntervalMs), which also keeps the tick-mapped input
   * timeline aligned. Do not "fix" pacing here by trusting Date.now().
   */
  private startTicker(arena: ArenaCore): void {
    if (this.ticking) return;
    this.ticking = true;
    let scheduled = Date.now();
    const loop = (): void => {
      if (arena.connectionCount === 0) {
        this.ticking = false;
        this.arena = null; // empty arena resets (ADR-0004)
        this.socketIds.clear();
        return;
      }
      arena.tick(TICK_DT_SEC);
      scheduled += TICK_DT_MS;
      if (Date.now() - scheduled > 2 * TICK_DT_MS) scheduled = Date.now();
      setTimeout(loop, Math.max(0, scheduled - Date.now()));
    };
    setTimeout(loop, TICK_DT_MS);
  }
}
