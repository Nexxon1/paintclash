/**
 * Arena-DO shell (ADR-0004: 1 DO = 1 arena): owns WebSockets and the 20 Hz
 * pacing, delegates every rule to the node-testable `ArenaCore`. Exercised
 * end-to-end by the scenario tests (`tests/scenario/`), not unit-tested —
 * there is deliberately no logic here.
 *
 * Live state is memory-only (ADR-0004): an eviction resets the arena. The
 * ticker only runs while sockets exist — an empty arena costs nothing
 * (spec §7.2: "nur ticken, wenn ein Spiel mit Spielern läuft").
 */

import { TICK_DT_MS, TICK_DT_SEC } from '@paintclash/shared';

import { ArenaCore } from './arena.js';

export class ArenaDO {
  private arena: ArenaCore | null = null;
  private readonly socketIds = new Map<WebSocket, number>();
  private ticking = false;

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    this.arena ??= new ArenaCore(crypto.getRandomValues(new Uint32Array(1))[0] ?? 1);
    const arena = this.arena;
    const playerId = arena.connect({
      send: (frame) => {
        server.send(frame);
      },
      close: (code, reason) => {
        server.close(code, reason);
      },
    });
    this.socketIds.set(server, playerId);

    server.addEventListener('message', (event) => {
      const data: unknown = event.data;
      // Text frames are protocol violations — run them through the same
      // malformed-frame accounting as binary garbage (spec §8.3).
      if (typeof data === 'string') {
        arena.handleFrame(playerId, new Uint8Array([0xff]));
        return;
      }
      if (data instanceof ArrayBuffer) {
        arena.handleFrame(playerId, new Uint8Array(data));
        return;
      }
      // Recent compat dates deliver binary frames as Blob (browser-style).
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => {
          arena.handleFrame(playerId, new Uint8Array(buffer));
        });
      }
    });
    const drop = (): void => {
      this.socketIds.delete(server);
      arena.disconnect(playerId);
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    this.startTicker(arena);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Self-rescheduling 50 ms cadence against a fixed schedule; stops when empty. */
  private startTicker(arena: ArenaCore): void {
    if (this.ticking) return;
    this.ticking = true;
    let scheduled = Date.now();
    const loop = (): void => {
      if (arena.connectionCount === 0) {
        this.ticking = false;
        this.arena = null; // empty arena resets (ADR-0004)
        return;
      }
      arena.tick(TICK_DT_SEC);
      scheduled += TICK_DT_MS;
      setTimeout(loop, Math.max(0, scheduled - Date.now()));
    };
    setTimeout(loop, TICK_DT_MS);
  }
}
