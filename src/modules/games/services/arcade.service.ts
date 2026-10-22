/** Stable import surface; implementations live in focused responsibility modules. */
export {
  ARCADE_GAME_TYPES,
  ArcadeGameType,
  ARCADE_ROOM_STATUSES,
  ArcadeRoomStatus,
  normalizeArcadeRoomStatus,
  ARCADE_CATALOG,
  ArcadeRuntimeState,
  assertArcadeGameType,
  withArcadeRoomLock,
  getRuntimeState,
  saveRuntimeState,
  createRuntimeState,
  patchRuntimeState,
  serializeArcadeRoom,
  getArcadeRoomById,
  getArcadeRoomByInvite,
  listArcadeRooms,
} from './arcade/arcade-game-types.service';
export {
  createArcadeRoom,
  joinArcadeRoom,
  setArcadeReady,
  abandonArcadeRoom,
  finishArcadeRoom,
  listArcadeHistory,
} from './arcade/create-arcade-room.service';
export { getArcadeLeaderboard } from './arcade/get-arcade-leaderboard.service';
