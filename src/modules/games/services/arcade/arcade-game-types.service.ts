import crypto from "crypto";
import { prisma } from "../../../../config/prisma";
import { redisCommand } from "../../../../infrastructure/redis/client";

export const ARCADE_GAME_TYPES = [
  'memory_match',
  'snake_duel',
  'paddle_volley',
  'maze_race_3d',
  'tic_tac_toe',
  'tap_duel',
] as const;

export type ArcadeGameType = (typeof ARCADE_GAME_TYPES)[number];

export const ARCADE_ROOM_STATUSES = ['waiting', 'in_progress', 'completed', 'abandoned'] as const;

export type ArcadeRoomStatus = (typeof ARCADE_ROOM_STATUSES)[number];

export const ROOM_TTL_SECONDS = 60 * 60 * 2;

export const MIN_REWARDED_DURATION_SECONDS = 20;

export const DAILY_REWARDED_MATCH_CAP = 10;

export const SAME_OPPONENT_DAILY_REWARDED_CAP = 3;

export const COMPLETION_XP = 10;

export const WINNER_BONUS_XP = 25;

export const DRAW_BONUS_XP = 15;

export function normalizeArcadeRoomStatus(status: unknown): ArcadeRoomStatus {
  return ARCADE_ROOM_STATUSES.includes(status as ArcadeRoomStatus)
    ? status as ArcadeRoomStatus
    : 'waiting';
}

export const ARCADE_CATALOG = [
  {
    type: 'memory_match',
    title: 'Memory Match Duel',
    description: 'Flip matching tiles against another player and build combo momentum.',
    minPlayers: 2,
    maxPlayers: 2,
    xpLabel: '10-35 XP',
    mode: 'turn_based',
  },
  {
    type: 'snake_duel',
    title: 'Snake Duel',
    description: 'Two snakes, one arena, shared pickups, and a 90-second sprint.',
    minPlayers: 2,
    maxPlayers: 2,
    xpLabel: '10-35 XP',
    mode: 'arcade',
  },
  {
    type: 'paddle_volley',
    title: 'Paddle Volley',
    description: 'Fast paddle rallies where the first to 7 wins.',
    minPlayers: 2,
    maxPlayers: 2,
    xpLabel: '10-35 XP',
    mode: 'arcade',
  },
  {
    type: 'maze_race_3d',
    title: '3D Maze Race',
    description: 'Race through a shared 3D maze seed, collect keys, and reach the exit first.',
    minPlayers: 2,
    maxPlayers: 2,
    xpLabel: '10-35 XP',
    mode: '3d',
  },
  {
    type: 'tic_tac_toe',
    title: 'Vormex Connect',
    description: 'Classic Tic-Tac-Toe locally with a friend.',
    minPlayers: 2,
    maxPlayers: 2,
    xpLabel: '10-35 XP',
    mode: 'turn_based',
  },
  {
    type: 'tap_duel',
    title: 'Tap Duel',
    description: 'Fast-paced screen-tapping competition.',
    minPlayers: 2,
    maxPlayers: 2,
    xpLabel: '10-35 XP',
    mode: 'arcade',
  },
] as const;

export interface ArcadeRuntimeState {
  roomId: string;
  gameType: ArcadeGameType;
  ready: Record<string, boolean>;
  players: string[];
  scores: Record<string, number>;
  status: ArcadeRoomStatus;
  startedAt?: string;
  updatedAt: string;
  payload?: unknown;
}

const memoryRuntimeState = new Map<string, ArcadeRuntimeState>();

function isRedisReady(): boolean {
  return Boolean(redisCommand && redisCommand.status === 'ready');
}

function stateKey(roomId: string): string {
  return `arcade:room:${roomId}:state`;
}

function lockKey(roomId: string): string {
  return `arcade:room:${roomId}:lock`;
}

export function normalizeGameType(value: unknown): ArcadeGameType | null {
  const gameType = String(value || '').trim();
  return ARCADE_GAME_TYPES.includes(gameType as ArcadeGameType)
    ? (gameType as ArcadeGameType)
    : null;
}

export function generateInviteCode(): string {
  return crypto.randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

export function generateSeed(): number {
  return crypto.randomInt(100_000, 999_999_999);
}

export function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isSameUtcDay(a: Date, b = new Date()): boolean {
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime();
}

export function isYesterdayUtc(a: Date, b = new Date()): boolean {
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime() - 86_400_000;
}

export function getPlayerIds(room: any): string[] {
  return [room.hostId, room.guestId].filter(Boolean).map(String);
}

export function getOpponentId(room: any, userId: string): string | null {
  if (room.hostId === userId) {
    return room.guestId || null;
  }
  if (room.guestId === userId) {
    return room.hostId || null;
  }
  return null;
}

export function getScoreForUser(room: any, userId: string): number {
  return room.hostId === userId ? room.hostScore : room.guestScore;
}

export function getScoreForOpponent(room: any, userId: string): number {
  return room.hostId === userId ? room.guestScore : room.hostScore;
}

export function getResultForUser(room: any, userId: string): 'win' | 'loss' | 'draw' {
  if (!room.winnerId) {
    return 'draw';
  }
  return room.winnerId === userId ? 'win' : 'loss';
}

export function assertArcadeGameType(value: unknown): ArcadeGameType {
  const gameType = normalizeGameType(value);
  if (!gameType) {
    throw Object.assign(new Error('Unsupported arcade game type'), { statusCode: 400 });
  }
  return gameType;
}

export async function withArcadeRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  if (!isRedisReady() || !redisCommand) {
    return fn();
  }

  const key = lockKey(roomId);
  const token = crypto.randomUUID();
  let acquired: string | null;
  try {
    acquired = await redisCommand.set(key, token, 'PX', 5_000, 'NX');
  } catch {
    // Readiness can change after the check; degrade to the local execution path.
    return fn();
  }
  if (!acquired) {
    throw Object.assign(new Error('Room is busy. Try again.'), { statusCode: 409 });
  }

  try {
    return await fn();
  } finally {
    await redisCommand.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token
    ).catch(() => undefined);
  }
}

export async function getRuntimeState(roomId: string): Promise<ArcadeRuntimeState | null> {
  if (isRedisReady() && redisCommand) {
    try {
      const raw = await redisCommand.get(stateKey(roomId));
      return raw ? (JSON.parse(raw) as ArcadeRuntimeState) : null;
    } catch {
      // Fall through to the per-process cache when Redis is unavailable/rate-limited.
    }
  }

  return memoryRuntimeState.get(roomId) || null;
}

export async function saveRuntimeState(state: ArcadeRuntimeState): Promise<ArcadeRuntimeState> {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };

  if (isRedisReady() && redisCommand) {
    try {
      await redisCommand.set(stateKey(state.roomId), JSON.stringify(nextState), 'EX', ROOM_TTL_SECONDS);
      return nextState;
    } catch {
      // Cache writes become best-effort and never fail the endpoint.
    }
  }

  memoryRuntimeState.set(state.roomId, nextState);

  return nextState;
}

export async function createRuntimeState(room: any): Promise<ArcadeRuntimeState> {
  const players = getPlayerIds(room);
  return saveRuntimeState({
    roomId: room.id,
    gameType: room.gameType,
    ready: Object.fromEntries(players.map((playerId) => [playerId, false])),
    players,
    scores: Object.fromEntries(players.map((playerId) => [playerId, 0])),
    status: normalizeArcadeRoomStatus(room.status),
    startedAt: room.startedAt?.toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export async function patchRuntimeState(
  room: any,
  patch: Partial<ArcadeRuntimeState>
): Promise<ArcadeRuntimeState> {
  const existing = (await getRuntimeState(room.id)) || (await createRuntimeState(room));
  return saveRuntimeState({
    ...existing,
    ...patch,
    roomId: room.id,
    gameType: room.gameType,
  });
}

export function serializeArcadeRoom(room: any, currentUserId?: string) {
  const playerIds = getPlayerIds(room);
  const currentUserRole =
    currentUserId && room.hostId === currentUserId
      ? 'host'
      : currentUserId && room.guestId === currentUserId
        ? 'guest'
        : null;

  return {
    id: room.id,
    gameType: room.gameType,
    inviteCode: room.inviteCode,
    status: room.status,
    seed: room.seed,
    hostReady: room.hostReady,
    guestReady: room.guestReady,
    hostScore: room.hostScore,
    guestScore: room.guestScore,
    winnerId: room.winnerId,
    metadata: room.metadata || null,
    createdAt: room.createdAt?.toISOString?.() || room.createdAt,
    updatedAt: room.updatedAt?.toISOString?.() || room.updatedAt,
    startedAt: room.startedAt?.toISOString?.() || null,
    completedAt: room.completedAt?.toISOString?.() || null,
    expiresAt: room.expiresAt?.toISOString?.() || null,
    currentUserRole,
    canJoin: room.status === 'waiting' && !room.guestId && (!currentUserId || room.hostId !== currentUserId),
    players: {
      host: room.host || null,
      guest: room.guest || null,
      winner: room.winner || null,
    },
    playerCount: playerIds.length,
    results: Array.isArray(room.results) ? room.results : [],
  };
}

export const roomInclude = {
  host: { select: { id: true, name: true, username: true, profileImage: true, headline: true, college: true } },
  guest: { select: { id: true, name: true, username: true, profileImage: true, headline: true, college: true } },
  winner: { select: { id: true, name: true, username: true, profileImage: true } },
  results: true,
};

export async function getArcadeRoomById(roomId: string) {
  return prisma.arcade_rooms.findUnique({
    where: { id: roomId },
    include: roomInclude,
  });
}

export async function getArcadeRoomByInvite(inviteCode: string) {
  return prisma.arcade_rooms.findUnique({
    where: { inviteCode },
    include: roomInclude,
  });
}

export async function listArcadeRooms(input: { gameType?: string; limit?: number }) {
  const gameType = input.gameType ? normalizeGameType(input.gameType) : null;
  const limit = Math.min(50, Math.max(1, input.limit || 20));

  return prisma.arcade_rooms.findMany({
    where: {
      status: 'waiting',
      guestId: null,
      expiresAt: { gt: new Date() },
      ...(gameType ? { gameType } : {}),
    },
    include: roomInclude,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
