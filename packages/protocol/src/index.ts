/**
 * `protocol` — binary wire format (encode/decode) + message types, shared
 * byte-for-byte by client and server (spec §5.1, §6.3, ADR-0002).
 */
export {
  decodeClientMessage,
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  encodeSnapshot,
  encodeWelcome,
  MAX_CLIENT_FRAME_BYTES,
  MAX_INPUT_BATCH,
  MAX_NAME_BYTES,
  MAX_NAME_CHARS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type InputItem,
  type ServerMessage,
  type SnapshotPlayer,
} from './messages.js';
