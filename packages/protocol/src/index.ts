/**
 * `protocol` — binary wire format (encode/decode) + message types, shared
 * byte-for-byte by client and server (spec §5.1, §6.3, ADR-0002).
 */
export {
  decodeClientMessage,
  decodeServerMessage,
  encodeDeath,
  encodeInput,
  encodeJoin,
  encodeLeaderboard,
  encodeScore,
  encodeSnapshot,
  encodeTerritory,
  encodeTrail,
  encodeWelcome,
  MAX_CLIENT_FRAME_BYTES,
  MAX_INPUT_BATCH,
  MAX_LEADERBOARD_ROWS,
  MAX_NAME_BYTES,
  MAX_NAME_CHARS,
  MAX_TRAIL_POINTS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type DeathCause,
  type InputItem,
  type LeaderboardRow,
  type ServerMessage,
  type SnapshotPlayer,
  type TerritoryReason,
} from './messages.js';
