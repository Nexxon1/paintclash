/**
 * Every WebSocket close code the server refuses or kicks with, in one file.
 *
 * They are shared because the reason has to survive the trip: a browser learns
 * *why* a socket closed only from the code it was closed with, and "Raum nicht
 * gefunden", "Spiel läuft schon" and "Arena voll" ask the player for three
 * different things. 4000–4999 is the range reserved for applications, so none of
 * these can be confused with a transport-level close (1006 and friends).
 *
 * They live TOGETHER because they share that one range: split across two
 * modules, the next code added on either side would eventually collide with one
 * on the other, and the symptom would be a player being told the wrong thing.
 * A refusal without a code of its own keeps the standard one (1008 for a client
 * that broke the protocol) — codes here are for reasons a *player* can act on.
 */

/** Refusals of a private room (spec §2.6, ticket 14). */
export const ROOM_CLOSE = Object.freeze({
  /** No room lives under this code — never created, or already closed. */
  unknown: 4001,
  /** The room is at its player limit (spec §2.6). */
  full: 4002,
  /** The game is in progress and the host switched late join off. */
  running: 4003,
});

/** Refusals of an arena's admission caps (spec §8.3, ticket 15). */
export const ARENA_CLOSE = Object.freeze({
  /**
   * The **Arena-Populationsgrenze** is reached (`LIMITS.maxPlayers`). Explicitly
   * not a queue and not a redirect (spec §8.3 point 4: no queue, no
   * auto-sharding) — the player is told, and trying again is theirs to decide.
   */
  full: 4004,
  /**
   * This address already holds `LIMITS.maxConnectionsPerIp` sockets in this
   * arena. The one refusal a legitimate player can trip (a shared WLAN is one
   * address), so it says so rather than looking like a broken connection.
   */
  tooManyConnections: 4005,
});
