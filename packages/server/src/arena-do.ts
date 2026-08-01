/**
 * Arena-DO shell (ADR-0004: 1 DO = 1 arena): owns WebSockets, the 20 Hz pacing
 * and — since ticket 14 — a private room's lobby and lifecycle. Every rule of
 * the GAME is delegated to the node-testable `ArenaCore`; every rule about a
 * room's settings and its code lives in `shared/room.ts`. Exercised end-to-end
 * by the scenario tests (`tests/scenario/`), not unit-tested.
 *
 * One class serves both kinds of arena, because they only differ in address and
 * in what they were told (ADR-0004): the public arena is `idFromName('public')`
 * with nothing in storage, a private room is `idFromName(code)` with its config
 * record in storage. `?room=` on the upgrade is how a socket says which one it
 * is asking for — the router only sets it when it addressed a code.
 *
 * Uses the WebSocket Hibernation API: its `webSocketClose`/`webSocketError`
 * handlers are delivered reliably (the classic `addEventListener('close')`
 * path is not under `wrangler dev`, which left ghost players in the arena).
 * As a backstop, a failing `send` also drops the connection.
 *
 * ## What survives hibernation, and why the split matters
 *
 * A lobby is meant to cost nothing (spec §2.6: "Leere/Lobby-Räume hibernieren"),
 * and a DO with open sockets but no timer running WILL be evicted from memory
 * and revived on the next event — instance fields and all. So the two kinds of
 * per-socket state are kept in two different places on purpose:
 *
 * - **Lobby identity** (id, name, host flag) lives in the socket's own
 *   *attachment*, which is exactly what hibernation preserves. A room can sit in
 *   its lobby for an hour, cost nothing, and still know who is waiting in it.
 * - **Membership of the running arena** lives in `socketIds`, in memory, and dies
 *   with the `ArenaCore` it refers to. That is the point: a player id only means
 *   something inside one arena instance, so after an eviction a socket holding a
 *   stale one is told to reconnect (1012) instead of steering whoever inherited
 *   its number.
 *
 * Live game state is memory-only (ADR-0004): an eviction resets the arena. The
 * ticker only runs while sockets exist — an empty arena costs nothing
 * (spec §7.2: "nur ticken, wenn ein Spiel mit Spielern läuft"). While the
 * ticker runs the DO cannot hibernate, so the in-memory arena and the
 * socket→player map never outlive each other.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  decodeClientMessage,
  encodeJoin,
  encodeLobby,
  type LobbyMember,
} from '@paintclash/protocol';
import {
  ARENA_CLOSE,
  BALANCE,
  LIMITS,
  ROOM_CLOSE,
  TICK_DT_MS,
  TICK_DT_SEC,
  sanitizeRoomConfig,
  type RoomConfig,
} from '@paintclash/shared';

import { ArenaCore, displayName } from './arena.js';
import { chargeFrame, type FrameWindow } from './flood.js';
import {
  clockAdvancesDuringWork,
  createTickCost,
  recordTick,
  tickCostReport,
  type TickCost,
} from './tick-cost.js';
import {
  CLIENT_IP_HEADER,
  UNKNOWN_ADDRESS,
  arenaSeedOverride,
  arenaSizeOverride,
  botTargetOverride,
  defaultBotTarget,
} from './router.js';

import type { ArenaSocket, ArenaStatsPayload } from './arena.js';
import type { Env } from './router.js';

/**
 * The room registry (ADR-0004: "SQLite im DO, Code → Konfig, selten
 * geschrieben") — one record, in the room's own storage. Its presence IS the
 * room: creating it makes the code live, deleting it frees the code again, and
 * nothing central has to be consulted either way.
 *
 * Written on creation, on a settings change and on the start — a handful of
 * row-writes per room in its whole life, which is what keeps private rooms
 * affordable on the Free plan's write budget.
 */
interface StoredRoom {
  /** The canonical code the router addressed this room by (spec §8.3). */
  code: string;
  config: RoomConfig;
  /** Secret that grants the host role on connect; see `freshHostToken`. */
  hostToken: string;
  /** Has the host started? A started room admits players, not lobby members. */
  started: boolean;
}

/** Per-socket lobby identity — the part that must survive hibernation. */
interface LobbySocket {
  /**
   * Lobby-local id: keys and colors the row in the lobby list, and numbers a
   * guest name. NOT the arena's player id — that one is handed out by
   * `ArenaCore` at the start and reaches the client in its `welcome`.
   */
  id: number;
  /** Resolved display name; `''` until the join frame arrives. */
  name: string;
  /** May change the settings and start the game. */
  host: boolean;
  /** Consecutive malformed frames on this socket (spec §8.3). */
  garbage: number;
  /** The caller address the router vouched for — see `addressIsFull`. */
  ip: string;
}

/** Address of a socket that has no lobby identity (the public arena's). */
interface PlainSocket {
  ip: string;
}

const ROOM_KEY = 'room';

/** Close code for a socket whose arena no longer exists — forces a clean rejoin. */
const CLOSE_ARENA_RESET = 1012;

export class ArenaDO extends DurableObject<Env> {
  private arena: ArenaCore | null = null;
  /**
   * Sockets that are players in the CURRENT `arena`. Deliberately in memory and
   * deliberately not the attachment: see the class comment.
   */
  private readonly socketIds = new Map<WebSocket, number>();
  private ticking = false;
  /** The room record; `undefined` = not read from storage yet, `null` = public. */
  private room: StoredRoom | null | undefined;
  /**
   * Frame budget per socket (spec §8.3 point 2, `flood.ts`). In memory and not
   * in the attachment, deliberately: a hibernating room receives no frames, so
   * the only thing a revived socket loses is a window it was not filling. Paying
   * for a serialize on every inbound frame — the one path a flood makes hot —
   * would be the protection creating the cost it exists to prevent.
   */
  private readonly frameWindows = new Map<WebSocket, FrameWindow>();
  /**
   * What the current arena's ticks cost (ticket 16, `tick-cost.ts`). Created
   * with the ticker and dropped with it, so the window a report covers is
   * exactly one arena's life — an arena that emptied and came back is a fresh
   * world with fresh territories, and averaging across the two would hide the
   * growth that drives the cost.
   */
  private tickCost: TickCost | null = null;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Only reachable from the router (a DO has no public address), so this is
    // the trusted side of the room-creation path.
    if (url.pathname === '/room' && request.method === 'POST') return this.createRoom(request);
    if (url.pathname === '/stats') return this.stats();
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }
    // Stamped by the router, which is the only place `CF-Connecting-IP` means
    // anything (spec §8.3 point 3, see `CLIENT_IP_HEADER`).
    const ip = request.headers.get(CLIENT_IP_HEADER) ?? UNKNOWN_ADDRESS;
    return url.searchParams.has('room') ? this.acceptRoom(url, ip) : this.acceptPublic(ip);
  }

  /**
   * Write this room's config, once (spec §2.6). A second attempt is answered
   * with 409 and NOT overwritten: to the router that means "this code already
   * names a live room, draw another one" — silently taking the code over would
   * drop the new host into strangers' room.
   */
  private async createRoom(request: Request): Promise<Response> {
    if (await this.loadRoom()) return new Response(null, { status: 409 });
    const wish: Record<string, unknown> = await request.json();
    const room: StoredRoom = {
      code: typeof wish.code === 'string' ? wish.code : '',
      // Sanitized here too, not just at the endpoint: this record outlives the
      // request that made it, so it is the one place the room's legality has to
      // hold — a config read back after a deploy gets the same treatment.
      config: sanitizeRoomConfig(wish.config),
      hostToken: typeof wish.hostToken === 'string' ? wish.hostToken : '',
      started: false,
    };
    await this.ctx.storage.put(ROOM_KEY, room);
    this.room = room;
    // Born empty: if nobody ever arrives, the grace alarm frees the code again.
    await this.armGrace();
    return new Response(null, { status: 201 });
  }

  /**
   * The tick budget as this object has been living it (ticket 16), for
   * `GET /api/arena-stats`. Answers even when nothing is running — "no arena
   * right now" is a true and useful answer, and a probe must never be the
   * thing that starts one.
   */
  private stats(): Response {
    const arena = this.arena;
    const cost = this.tickCost;
    const payload: ArenaStatsPayload = {
      live: arena !== null && this.ticking,
      load: arena?.load ?? null,
      tickCost: cost === null ? null : tickCostReport(cost, Date.now()),
    };
    return Response.json(payload);
  }

  /**
   * The room record, read at most once per instance. `undefined` vs `null`
   * matters: `null` means "read it, there is no room" (the public arena), and
   * `??=` would keep re-reading storage for it on every disconnect.
   */
  private async loadRoom(): Promise<StoredRoom | null> {
    if (this.room === undefined) {
      this.room = (await this.ctx.storage.get<StoredRoom>(ROOM_KEY)) ?? null;
    }
    return this.room;
  }

  /** The one public arena (ADR-0004): joins straight into the running world. */
  private acceptPublic(ip: string): Response {
    const { client, server } = this.upgrade();
    if (this.addressIsFull(server, ip)) {
      server.close(ARENA_CLOSE.tooManyConnections, 'too many connections');
      return this.upgraded(client);
    }
    this.attachAddress(server, ip);
    const arenaSizeWU = arenaSizeOverride(this.env.ARENA_SIZE_WU) ?? BALANCE.arena.sizeWU;
    const arena = (this.arena ??= new ArenaCore(this.freshSeed(), {
      sizeWU: arenaSizeWU,
      // This is the PUBLIC arena, so it is the one that gets kept populated
      // (spec §2.7) — `ArenaCore` itself stays bot-free unless asked. An
      // explicit ARENA_BOTS is a deliberate choice and wins; otherwise the
      // default is sized to the arena, because a flat target does not survive a
      // small map (see `defaultBotTarget`).
      botTarget: botTargetOverride(this.env.ARENA_BOTS) ?? defaultBotTarget(arenaSizeWU),
    }));
    const playerId = arena.connect(this.socketFor(server));
    if (playerId === null) {
      // Spec §8.3 point 4: the Arena-Populationsgrenze is reached. A clean
      // refusal with a reason the client can put on screen — no queue, no
      // redirect to a second arena (scaling is out of scope).
      server.close(ARENA_CLOSE.full, 'arena full');
      return this.upgraded(client);
    }
    this.socketIds.set(server, playerId);
    this.startTicker(arena);
    return this.upgraded(client);
  }

  /**
   * A private room (spec §2.6): the socket lands in the lobby, or — if the host
   * already started and left the door open — straight in the game.
   */
  private async acceptRoom(url: URL, ip: string): Promise<Response> {
    const room = await this.loadRoom();
    const { client, server } = this.upgrade();
    if (this.addressIsFull(server, ip)) {
      server.close(ARENA_CLOSE.tooManyConnections, 'too many connections');
      return this.upgraded(client);
    }
    if (!room) {
      // No record under this code: never created, or closed after its grace
      // period. Either way the code is not a room, and saying so is the whole
      // point of a close reason.
      server.close(ROOM_CLOSE.unknown, 'room unknown');
      return this.upgraded(client);
    }
    const peers = this.liveSockets(server);
    if (peers.length >= room.config.playerLimit) {
      server.close(ROOM_CLOSE.full, 'room full');
      return this.upgraded(client);
    }
    // Late join is about walking into a game IN PROGRESS. A started room whose
    // players have all gone is not in progress — the first to come back re-enters
    // it (with a fresh world, ADR-0004). Refusing them would turn any eviction,
    // or everyone reloading at once, into a lockout from their own room.
    if (room.started && peers.length > 0 && !room.config.lateJoin) {
      server.close(ROOM_CLOSE.running, 'game already running');
      return this.upgraded(client);
    }
    const claimsHost = room.hostToken !== '' && url.searchParams.get('host') === room.hostToken;
    // The token wins outright (it is the creator coming back, possibly after a
    // reload). Failing that, a room whose host has left hands the role to whoever
    // is here — otherwise a host who closed their tab would leave a lobby that
    // nobody can ever start.
    if (claimsHost) this.demoteHosts();
    const host = claimsHost || !peers.some((peer) => this.stateOf(peer)?.host);
    // Attached before the first await of this path, deliberately: everything
    // above decided against a socket list that must not change underneath it.
    // Two upgrades from one address that both suspended before writing their
    // address would both have counted zero and both been admitted.
    this.attach(server, { id: this.freshLobbyId(peers), name: '', host, garbage: 0, ip });
    // Occupied again: the grace timer is not wanted until it empties.
    await this.ctx.storage.deleteAlarm();
    return this.upgraded(client);
  }

  /**
   * Does this address already hold as many sockets in this arena as it may
   * (spec §8.3 point 3)? Counted from the live sockets rather than from a
   * bookkeeping counter, because a socket IS the thing being limited: nothing
   * can leak, nothing has to be released, and an eviction cannot leave an
   * address locked out of its own arena.
   *
   * `fresh` is the socket asking, which `getWebSockets()` already lists.
   */
  private addressIsFull(fresh: WebSocket, ip: string): boolean {
    let held = 0;
    for (const peer of this.liveSockets(fresh)) {
      if (this.addressOf(peer) === ip) held += 1;
    }
    return held >= LIMITS.maxConnectionsPerIp;
  }

  /** The address a socket counts against; `unknown` if it carries none. */
  private addressOf(ws: WebSocket): string {
    const raw: unknown = ws.deserializeAttachment();
    if (typeof raw !== 'object' || raw === null) return UNKNOWN_ADDRESS;
    const ip = (raw as Partial<PlainSocket>).ip;
    return typeof ip === 'string' ? ip : UNKNOWN_ADDRESS;
  }

  /**
   * The attachment of a public-arena socket: its address and nothing else. It
   * deliberately carries no lobby identity, which is what `stateOf` reads — a
   * public socket has none, and a room socket's identity is written over this by
   * `attach` (`LobbySocket` carries the address along).
   */
  private attachAddress(ws: WebSocket, ip: string): void {
    const state: PlainSocket = { ip };
    ws.serializeAttachment(state);
  }

  override webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void | Promise<void> {
    // Frame budget FIRST (spec §8.3 point 2, `flood.ts`): a dropped frame must
    // cost nothing beyond this counter — no decode, no player lookup, no
    // allocation. That is the entire protection against a flood on a
    // single-threaded arena.
    const charged = chargeFrame(this.frameWindows.get(ws), Date.now());
    this.frameWindows.set(ws, charged.window);
    if (charged.verdict === 'kill') {
      ws.close(1008, 'input flood');
      return this.drop(ws);
    }
    if (charged.verdict === 'drop') return;
    // Text frames are protocol violations — run them through the same
    // malformed-frame accounting as binary garbage (spec §8.3).
    const bytes = typeof message === 'string' ? new Uint8Array([0xff]) : new Uint8Array(message);
    const playerId = this.socketIds.get(ws);
    if (playerId !== undefined) {
      // The hot path, kept synchronous: a player in the running arena. It reads
      // in-memory state only, so input frames cannot be reordered by an await.
      if (!this.arena) {
        ws.close(CLOSE_ARENA_RESET, 'arena reset');
        return;
      }
      this.arena.handleFrame(playerId, bytes);
      return;
    }
    return this.roomMessage(ws, bytes);
  }

  /**
   * A frame from a socket that is not (yet) a player: a lobby member, or a
   * late joiner announcing itself. Rare and allowed to await.
   */
  private async roomMessage(ws: WebSocket, bytes: Uint8Array): Promise<void> {
    const room = await this.loadRoom();
    // Read the attachment only after the await: two frames arriving back to back
    // both suspend here, and a state captured beforehand would be stale by the
    // time the second one resumed (two joins would then buy two player ids for
    // one socket, leaving a ghost in the arena).
    const state = this.stateOf(ws);
    if (!state || !room) {
      // A public-arena socket from before a reset/eviction, or a room socket
      // whose record is gone: force a clean rejoin.
      ws.close(CLOSE_ARENA_RESET, 'arena reset');
      return;
    }
    if (room.started && state.name !== '') {
      // It played in an arena this instance no longer has (eviction, deploy).
      // The player id it holds means nothing here, so reconnecting is the only
      // honest answer — the room itself is still standing and will take it back.
      ws.close(CLOSE_ARENA_RESET, 'arena reset');
      return;
    }
    const decoded = decodeClientMessage(bytes);
    if (!decoded) {
      state.garbage += 1;
      this.attach(ws, state);
      if (state.garbage >= LIMITS.garbageKillThreshold) ws.close(1008, 'persistent garbage');
      return;
    }
    state.garbage = 0;
    this.attach(ws, state);
    if (decoded.type === 'join') {
      if (state.name !== '') return; // already announced; a second join is noise
      // The name is resolved HERE rather than in the arena, because a lobby list
      // cannot show a blank row. The policy is idempotent, so the arena will
      // arrive at the same string when this socket is admitted (see
      // `displayName`) — what a player saw in the lobby is what they keep.
      state.name = displayName(decoded.name, state.id);
      this.attach(ws, state);
      if (room.started) this.admit(ws, state, room);
      else this.broadcastLobby(room);
      return;
    }
    // Everything below is the host's alone (spec §2.6: Host-Start). A member
    // asking is ignored rather than disconnected: it is a manipulated client at
    // worst, and it cannot express anything else here anyway.
    if (!state.host || room.started) return;
    if (decoded.type === 'roomSettings') {
      // The limit is an ADMISSION rule (spec §2.6), so it never shrinks below the
      // people already in the room: without this floor, a host lowering it to two
      // would have the third and fourth member closed with "room full" — at the
      // start, minutes later, for having arrived first.
      const waiting = this.members(this.liveSockets()).filter(
        (entry) => entry.state.name !== '',
      ).length;
      room.config = sanitizeRoomConfig({
        ...decoded.config,
        playerLimit: Math.max(decoded.config.playerLimit, waiting),
      });
      await this.ctx.storage.put(ROOM_KEY, room);
      this.broadcastLobby(room);
      return;
    }
    if (decoded.type === 'roomStart') await this.startGame(room);
  }

  /**
   * The host pressed start: the room becomes a running arena and every member
   * who has announced a name becomes a player. Sockets that have not (a link
   * opened in the same instant) find the room started when their join lands and
   * are admitted then, through the late-join path.
   */
  private async startGame(room: StoredRoom): Promise<void> {
    room.started = true;
    await this.ctx.storage.put(ROOM_KEY, room);
    // By lobby id, so the arena hands out player ids in the order the lobby
    // showed — `getWebSockets()` has no order worth relying on.
    const waiting = this.members(this.liveSockets());
    for (const { ws, state } of waiting) {
      if (state.name !== '') this.admit(ws, state, room);
    }
  }

  /**
   * Turn one lobby socket into a player. The join frame is re-encoded and fed
   * through `ArenaCore.handleFrame`, i.e. through exactly the trust boundary a
   * public join passes (spec §8.2): the arena allocates the id, enforces the
   * name policy, sends the welcome and syncs the world. Nothing about a room
   * player is a special case inside the sim.
   */
  private admit(ws: WebSocket, state: LobbySocket, room: StoredRoom): void {
    const arena = this.arenaFor(room);
    const playerId = arena.connect(this.socketFor(ws));
    if (playerId === null) {
      // The socket-level limit already passed, so this is the arena's own
      // backstop firing — a race between two joins on a full room.
      ws.close(ROOM_CLOSE.full, 'room full');
      return;
    }
    this.socketIds.set(ws, playerId);
    arena.handleFrame(playerId, encodeJoin(state.name));
    this.startTicker(arena);
  }

  /** This room's arena, built from the settings the host committed. */
  private arenaFor(room: StoredRoom): ArenaCore {
    return (this.arena ??= new ArenaCore(this.freshSeed(), {
      sizeWU: room.config.mapSizeWU,
      // The host's number verbatim, NOT `defaultBotTarget`: spec §10.4 hands
      // bots to the host as a toggle, so a deliberate choice must not be
      // second-guessed by the area rule (the hard ceiling stays
      // `BALANCE.bots.maxBots`, applied where bots are spawned).
      botTarget: room.config.botTarget,
      maxPlayers: room.config.playerLimit,
    }));
  }

  /**
   * Send every named member its own view of the lobby (spec §2.6). Per
   * recipient, because `selfId` is what marks "you" — names are not unique, so
   * nothing else in the frame could.
   */
  private broadcastLobby(room: StoredRoom, exclude?: WebSocket): void {
    if (room.started) return; // a running room has no lobby
    const present = this.members(this.liveSockets(exclude)).filter(
      (entry) => entry.state.name !== '',
    );
    const members: LobbyMember[] = present.map(({ state }) => ({
      playerId: state.id,
      name: state.name,
      host: state.host,
    }));
    for (const { ws, state } of present) {
      try {
        ws.send(encodeLobby({ code: room.code, config: room.config, selfId: state.id, members }));
      } catch {
        // Socket died without a close event yet — the close handler cleans up.
      }
    }
  }

  override webSocketClose(ws: WebSocket): void | Promise<void> {
    return this.drop(ws);
  }

  override webSocketError(ws: WebSocket): void | Promise<void> {
    return this.drop(ws);
  }

  private async drop(ws: WebSocket): Promise<void> {
    const playerId = this.socketIds.get(ws);
    this.socketIds.delete(ws);
    this.frameWindows.delete(ws);
    if (playerId !== undefined) this.arena?.disconnect(playerId);
    const room = await this.loadRoom();
    if (!room) return; // the public arena has no lifecycle to manage
    // Excluded explicitly rather than trusting `readyState` to have flipped
    // already: whether a socket is still listed while its close is delivered is
    // not something this code should have an opinion about.
    const remaining = this.liveSockets(ws);
    if (remaining.length === 0) {
      // Empty: start the grace period (spec §2.6 — it covers short
      // disconnects, a reload, a tunnel hiccup).
      await this.armGrace();
      return;
    }
    // Someone left a lobby: the list changed, and possibly the host with it.
    if (!remaining.some((peer) => this.stateOf(peer)?.host === true)) this.promoteHost(remaining);
    this.broadcastLobby(room, ws);
  }

  /**
   * The grace period expired (spec §2.6): if the room is still empty it closes
   * and its code is free again — deleting the record is all that takes, because
   * the record's presence is what makes a code a room.
   */
  override async alarm(): Promise<void> {
    if (this.liveSockets().length > 0) return; // came back inside the grace
    await this.ctx.storage.deleteAll();
    this.room = null;
    this.arena = null;
    this.socketIds.clear();
  }

  private async armGrace(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + BALANCE.room.graceSeconds * 1000);
  }

  /** Sockets still open, optionally excluding one (a closing or fresh socket). */
  private liveSockets(exclude?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  /**
   * The sockets that carry a lobby identity, in lobby-id order — the order the
   * lobby list showed, and the order player ids are handed out in at the start.
   * `getWebSockets()` has no order worth relying on.
   */
  private members(sockets: readonly WebSocket[]): { ws: WebSocket; state: LobbySocket }[] {
    return sockets
      .map((ws) => ({ ws, state: this.stateOf(ws) }))
      .filter((entry): entry is { ws: WebSocket; state: LobbySocket } => entry.state !== null)
      .sort((a, b) => a.state.id - b.state.id);
  }

  /** Hand the host role to the longest-waiting member (lowest lobby id). */
  private promoteHost(candidates: readonly WebSocket[]): void {
    const heir = this.members(candidates)[0];
    if (!heir) return;
    heir.state.host = true;
    this.attach(heir.ws, heir.state);
  }

  private demoteHosts(): void {
    for (const ws of this.liveSockets()) {
      const state = this.stateOf(ws);
      if (state?.host === true) {
        state.host = false;
        this.attach(ws, state);
      }
    }
  }

  /** Smallest id no live socket holds — ids are recycled, like the arena's. */
  private freshLobbyId(peers: readonly WebSocket[]): number {
    const taken = new Set(peers.map((ws) => this.stateOf(ws)?.id));
    for (let id = 1; ; id++) {
      if (!taken.has(id)) return id;
    }
  }

  private stateOf(ws: WebSocket): LobbySocket | null {
    const raw: unknown = ws.deserializeAttachment();
    if (typeof raw !== 'object' || raw === null) return null;
    const state = raw as Partial<LobbySocket>;
    if (typeof state.id !== 'number' || typeof state.name !== 'string') return null;
    return {
      id: state.id,
      name: state.name,
      host: state.host === true,
      garbage: state.garbage ?? 0,
      // Read back and written along by `attach`, so re-attaching a lobby
      // identity never drops the address the per-IP cap counts.
      ip: state.ip ?? UNKNOWN_ADDRESS,
    };
  }

  private attach(ws: WebSocket, state: LobbySocket): void {
    ws.serializeAttachment(state);
  }

  /** A fresh WebSocket pair with the server end accepted for hibernation. */
  private upgrade(): { client: WebSocket; server: WebSocket } {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    return { client, server };
  }

  private upgraded(client: WebSocket): Response {
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A pinned seed (dev/test only) makes every spawn reproducible — including a
   * private room's, which is what lets the scenario suite fly choreographies in
   * one. Without it each arena gets its own random world.
   */
  private freshSeed(): number {
    return (
      arenaSeedOverride(this.env.ARENA_SEED) ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 1
    );
  }

  /** The transport `ArenaCore` needs, bound to one socket. */
  private socketFor(ws: WebSocket): ArenaSocket {
    return {
      send: (frame) => {
        try {
          ws.send(frame);
        } catch {
          // Socket died without a close event — drop the player.
          void this.drop(ws);
        }
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
        // The arena killed this socket itself (idle/garbage) — don't wait
        // for a close event that a half-open connection may never deliver.
        void this.drop(ws);
      },
    };
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
   *
   * From the second tick on, `scheduled` names the slot the tick about to run
   * was aimed at, which is what makes `now - scheduled` the measurement
   * `tick-cost.ts` interprets. The pacing itself is untouched by that
   * measurement — deliberately: this loop's cadence is ticket 18's subject, and
   * a benchmark must not move the thing it is benchmarking. (It was tried: one
   * tick of phase shift is enough to change who reaches whom first in the
   * rewind choreography, `tests/scenario/rewind.test.ts`.)
   */
  private startTicker(arena: ArenaCore): void {
    if (this.ticking) return;
    this.ticking = true;
    // Probed here, once, while the arena is still empty and nobody is waiting
    // on a tick — and NOT in `stats()`, where it would burn the same CPU on
    // every read of a public endpoint.
    const cost = (this.tickCost = createTickCost(Date.now(), clockAdvancesDuringWork()));
    let scheduled = Date.now();
    let first = true;
    const loop = (): void => {
      if (arena.connectionCount === 0) {
        this.ticking = false;
        this.arena = null; // empty arena resets (ADR-0004)
        this.socketIds.clear();
        return;
      }
      // Recorded before the work, so it says how late THIS tick came — which on
      // Cloudflare is what the previous one cost (see `tick-cost.ts`). The very
      // first tick is skipped: it has no predecessor whose cost it could carry,
      // and it is the one tick aimed a slot past `scheduled` (the initial
      // `setTimeout` below), so recording it would only feed startup jitter
      // into the histogram.
      if (first) first = false;
      else recordTick(cost, Date.now(), scheduled);
      arena.tick(TICK_DT_SEC);
      scheduled += TICK_DT_MS;
      if (Date.now() - scheduled > 2 * TICK_DT_MS) scheduled = Date.now();
      setTimeout(loop, Math.max(0, scheduled - Date.now()));
    };
    setTimeout(loop, TICK_DT_MS);
  }
}
