/**
 * `shared` — single source of truth for balance parameters (spec §10),
 * cross-package constants/types (incl. the 20 Hz tick) and the few rules both
 * ends of the wire must decide identically (the nickname policy, spec §2.8).
 *
 * @see spec §5.1, ADR-0002
 */
export {
  BALANCE,
  MAP_SHARE_PERCENT_SCALE,
  TICK_DT_MS,
  TICK_DT_SEC,
  TICK_HZ,
  TURN_RADIUS_WU,
} from './balance.js';
export { LIMITS } from './limits.js';
export {
  NICKNAME,
  checkNickname,
  nicknameContentChanged,
  sanitizeNickname,
  type NicknameVerdict,
} from './nickname.js';
export {
  ROOM_CLOSE,
  ROOM_CODE,
  defaultMapSizeWU,
  defaultRoomConfig,
  normalizeRoomCode,
  roomCodeFrom,
  roomPath,
  roomShareLink,
  sanitizeRoomConfig,
  type RoomConfig,
} from './room.js';
export type {
  DeathCause,
  LifeCounters,
  Point,
  Poly,
  Ring,
  Territory,
  TurnSignal,
} from './types.js';
