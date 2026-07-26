import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { redisCommand } from '../infrastructure/redis/client';
import { awardUserProgress } from './progress.service';

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

const ROOM_TTL_SECONDS = 60 * 60 * 2;
const MIN_REWARDED_DURATION_SECONDS = 20;
const DAILY_REWARDED_MATCH_CAP = 10;
const SAME_OPPONENT_DAILY_REWARDED_CAP = 3;
const COMPLETION_XP = 10;
const WINNER_BONUS_XP = 25;
const DRAW_BONUS_XP = 15;

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

function normalizeGameType(value: unknown): ArcadeGameType | null {
  const gameType = String(value || '').trim();
  return ARCADE_GAME_TYPES.includes(gameType as ArcadeGameType)
    ? (gameType as ArcadeGameType)
    : null;
}

function generateInviteCode(): string {
  return crypto.randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

function generateSeed(): number {
  return crypto.randomInt(100_000, 999_999_999);
}

function startOfUtcDay(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isSameUtcDay(a: Date, b = new Date()): boolean {
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime();
}

function isYesterdayUtc(a: Date, b = new Date()): boolean {
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime() - 86_400_000;
}

function getPlayerIds(room: any): string[] {
  return [room.hostId, room.guestId].filter(Boolean).map(String);
}

function getOpponentId(room: any, userId: string): string | null {
  if (room.hostId === userId) {
    return room.guestId || null;
  }
  if (room.guestId === userId) {
    return room.hostId || null;
  }
  return null;
}

function getScoreForUser(room: any, userId: string): number {
  return room.hostId === userId ? room.hostScore : room.guestScore;
}

function getScoreForOpponent(room: any, userId: string): number {
  return room.hostId === userId ? room.guestScore : room.hostScore;
}

function getResultForUser(room: any, userId: string): 'win' | 'loss' | 'draw' {
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

const roomInclude = {
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

export async function createArcadeRoom(input: { userId: string; gameType: string }) {
  const gameType = assertArcadeGameType(input.gameType);
  const expiresAt = new Date(Date.now() + ROOM_TTL_SECONDS * 1000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inviteCode = generateInviteCode();
    const existing = await prisma.arcade_rooms.findUnique({ where: { inviteCode } });
    if (existing) continue;

    const room = await prisma.arcade_rooms.create({
      data: {
        gameType,
        hostId: input.userId,
        inviteCode,
        seed: generateSeed(),
        expiresAt,
      },
      include: roomInclude,
    });

    await createRuntimeState(room);
    return room;
  }

  throw Object.assign(new Error('Could not create a unique invite code'), { statusCode: 500 });
}

export async function joinArcadeRoom(input: { userId: string; roomId?: string; inviteCode?: string }) {
  const room =
    input.roomId
      ? await getArcadeRoomById(input.roomId)
      : input.inviteCode
        ? await getArcadeRoomByInvite(input.inviteCode)
        : null;

  if (!room) {
    throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
  }
  if (room.hostId === input.userId) {
    return room;
  }
  if (room.guestId && room.guestId !== input.userId) {
    throw Object.assign(new Error('Arcade room is full'), { statusCode: 409 });
  }
  if (room.status !== 'waiting') {
    throw Object.assign(new Error('Arcade room is no longer joinable'), { statusCode: 409 });
  }

  const updatedRoom = await prisma.arcade_rooms.update({
    where: { id: room.id },
    data: { guestId: input.userId, expiresAt: new Date(Date.now() + ROOM_TTL_SECONDS * 1000) },
    include: roomInclude,
  });

  await createRuntimeState(updatedRoom);
  return updatedRoom;
}

export async function setArcadeReady(input: { userId: string; roomId: string; ready: boolean }) {
  return withArcadeRoomLock(input.roomId, async () => {
    const room = await getArcadeRoomById(input.roomId);
    if (!room) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }
    if (room.hostId !== input.userId && room.guestId !== input.userId) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }

    const isHost = room.hostId === input.userId;
    const nextHostReady = isHost ? input.ready : room.hostReady;
    const nextGuestReady = !isHost ? input.ready : room.guestReady;
    const shouldStart = room.status === 'waiting' && Boolean(room.guestId) && nextHostReady && nextGuestReady;

    const updatedRoom = await prisma.arcade_rooms.update({
      where: { id: room.id },
      data: {
        hostReady: nextHostReady,
        guestReady: nextGuestReady,
        ...(shouldStart ? { status: 'in_progress', startedAt: new Date() } : {}),
      },
      include: roomInclude,
    });

    await patchRuntimeState(updatedRoom, {
      status: normalizeArcadeRoomStatus(updatedRoom.status),
      players: getPlayerIds(updatedRoom),
      ready: {
        [updatedRoom.hostId]: updatedRoom.hostReady,
        ...(updatedRoom.guestId ? { [updatedRoom.guestId]: updatedRoom.guestReady } : {}),
      },
      startedAt: updatedRoom.startedAt?.toISOString(),
    });

    return updatedRoom;
  });
}

export async function abandonArcadeRoom(input: { userId: string; roomId: string }) {
  return withArcadeRoomLock(input.roomId, async () => {
    const room = await getArcadeRoomById(input.roomId);
    if (!room) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }
    if (room.hostId !== input.userId && room.guestId !== input.userId) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }
    if (room.status === 'completed') {
      return room;
    }

    const updatedRoom = await prisma.arcade_rooms.update({
      where: { id: room.id },
      data: { status: 'abandoned', completedAt: new Date() },
      include: roomInclude,
    });
    await patchRuntimeState(updatedRoom, { status: 'abandoned' });
    return updatedRoom;
  });
}

async function hasRewardCapacity(userId: string, opponentId: string | null): Promise<boolean> {
  const today = startOfUtcDay();
  const rewardedToday = await prisma.arcade_results.count({
    where: {
      userId,
      xpEarned: { gt: 0 },
      createdAt: { gte: today },
    },
  });

  if (rewardedToday >= DAILY_REWARDED_MATCH_CAP) {
    return false;
  }

  if (!opponentId) {
    return true;
  }

  const sameOpponentToday = await prisma.arcade_results.count({
    where: {
      userId,
      opponentId,
      xpEarned: { gt: 0 },
      createdAt: { gte: today },
    },
  });

  return sameOpponentToday < SAME_OPPONENT_DAILY_REWARDED_CAP;
}

function calculateReward(result: 'win' | 'loss' | 'draw', canReward: boolean): number {
  if (!canReward) {
    return 0;
  }
  if (result === 'win') {
    return COMPLETION_XP + WINNER_BONUS_XP;
  }
  if (result === 'draw') {
    return COMPLETION_XP + DRAW_BONUS_XP;
  }
  return COMPLETION_XP;
}

async function updateGameStatsForArcade(input: {
  userId: string;
  xpEarned: number;
  playedAt: Date;
}) {
  const existing = await prisma.game_stats.findUnique({ where: { userId: input.userId } });
  const currentStreak = existing?.lastPlayedAt
    ? isSameUtcDay(existing.lastPlayedAt, input.playedAt)
      ? existing.currentStreak
      : isYesterdayUtc(existing.lastPlayedAt, input.playedAt)
        ? existing.currentStreak + 1
        : 1
    : 1;

  await prisma.game_stats.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      totalGamesPlayed: 1,
      totalXpEarned: input.xpEarned,
      currentStreak,
      bestStreak: currentStreak,
      lastPlayedAt: input.playedAt,
    },
    update: {
      totalGamesPlayed: { increment: 1 },
      totalXpEarned: { increment: input.xpEarned },
      currentStreak,
      bestStreak: Math.max(existing?.bestStreak || 0, currentStreak),
      lastPlayedAt: input.playedAt,
    },
  });
}

async function createArcadeResult(input: {
  room: any;
  userId: string;
  durationSeconds: number;
  rewardEligible: boolean;
  metadata?: unknown;
}) {
  const opponentId = getOpponentId(input.room, input.userId);
  const result = getResultForUser(input.room, input.userId);
  const canReward = input.rewardEligible && (await hasRewardCapacity(input.userId, opponentId));
  const xpEarned = calculateReward(result, canReward);
  const existing = await prisma.arcade_results.findUnique({
    where: { roomId_userId: { roomId: input.room.id, userId: input.userId } },
  });

  if (existing) {
    return existing;
  }

  const created = await prisma.arcade_results.create({
    data: {
      roomId: input.room.id,
      gameType: input.room.gameType,
      userId: input.userId,
      opponentId,
      result,
      score: getScoreForUser(input.room, input.userId),
      opponentScore: getScoreForOpponent(input.room, input.userId),
      xpEarned,
      coinsEarned: xpEarned,
      durationSeconds: input.durationSeconds,
      metadata: input.metadata as any,
    },
  });

  if (xpEarned > 0) {
    await awardUserProgress({
      userId: input.userId,
      xpAmount: xpEarned,
      coinAmount: xpEarned,
      type: 'arcade_match_complete',
      source: `arcade_${input.room.gameType}`,
      sourceId: input.room.id,
      description: `Completed ${input.room.gameType.replace(/_/g, ' ')} match`,
      countsForStreak: true,
      idempotencyKey: `${input.userId}:arcade:${input.room.id}`,
    });
  }

  await updateGameStatsForArcade({
    userId: input.userId,
    xpEarned,
    playedAt: created.createdAt,
  });

  return created;
}

export async function finishArcadeRoom(input: {
  userId: string;
  roomId: string;
  hostScore: number;
  guestScore: number;
  durationSeconds: number;
  metadata?: unknown;
}) {
  return withArcadeRoomLock(input.roomId, async () => {
    const room = await getArcadeRoomById(input.roomId);
    if (!room) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }
    if (room.hostId !== input.userId && room.guestId !== input.userId) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }
    if (!room.guestId) {
      throw Object.assign(new Error('Arcade room needs an opponent before it can finish'), { statusCode: 400 });
    }

    const hostScore = Math.max(0, Math.floor(Number(input.hostScore) || 0));
    const guestScore = Math.max(0, Math.floor(Number(input.guestScore) || 0));
    const durationSeconds = Math.max(0, Math.floor(Number(input.durationSeconds) || 0));
    const winnerId = hostScore === guestScore ? null : hostScore > guestScore ? room.hostId : room.guestId;

    const completedRoom =
      room.status === 'completed'
        ? room
        : await prisma.arcade_rooms.update({
            where: { id: room.id },
            data: {
              status: 'completed',
              completedAt: new Date(),
              hostScore,
              guestScore,
              winnerId,
              metadata: input.metadata as any,
            },
            include: roomInclude,
          });

    const rewardEligible = durationSeconds >= MIN_REWARDED_DURATION_SECONDS;
    await Promise.all(
      getPlayerIds(completedRoom).map((playerId) =>
        createArcadeResult({
          room: completedRoom,
          userId: playerId,
          durationSeconds,
          rewardEligible,
          metadata: input.metadata,
        })
      )
    );

    const finalRoom = await getArcadeRoomById(room.id);
    if (!finalRoom) {
      throw Object.assign(new Error('Arcade room not found'), { statusCode: 404 });
    }

    await patchRuntimeState(finalRoom, {
      status: 'completed',
      scores: {
        [finalRoom.hostId]: finalRoom.hostScore,
        ...(finalRoom.guestId ? { [finalRoom.guestId]: finalRoom.guestScore } : {}),
      },
      payload: {
        winnerId: finalRoom.winnerId,
        results: finalRoom.results,
      },
    });

    return finalRoom;
  });
}

export async function listArcadeHistory(input: { userId: string; limit?: number }) {
  const limit = Math.min(50, Math.max(1, input.limit || 20));
  return prisma.arcade_results.findMany({
    where: { userId: input.userId },
    include: {
      room: {
        include: roomInclude,
      },
      opponent: {
        select: { id: true, name: true, username: true, profileImage: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getArcadeLeaderboard(input: { gameType?: string; limit?: number }) {
  const gameType = input.gameType ? normalizeGameType(input.gameType) : null;
  const limit = Math.min(50, Math.max(1, input.limit || 20));
  const grouped = await prisma.arcade_results.groupBy({
    by: ['userId'],
    where: {
      xpEarned: { gt: 0 },
      ...(gameType ? { gameType } : {}),
    },
    _sum: {
      xpEarned: true,
      score: true,
    },
    _count: {
      _all: true,
    },
    orderBy: {
      _sum: {
        xpEarned: 'desc',
      },
    },
    take: limit,
  });

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((entry) => entry.userId) } },
    select: { id: true, name: true, username: true, profileImage: true },
  });
  const userMap = new Map(users.map((user) => [user.id, user]));

  return grouped
    .map((entry, index) => ({
      rank: index + 1,
      user: userMap.get(entry.userId),
      xp: entry._sum.xpEarned || 0,
      score: entry._sum.score || 0,
      gamesPlayed: entry._count._all,
    }))
    .filter((entry) => Boolean(entry.user));
}
