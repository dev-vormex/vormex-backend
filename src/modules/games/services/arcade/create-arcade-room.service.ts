import { prisma } from "../../../../config/prisma";
import { awardUserProgress } from "../../../engagement/services/progress.service";
import { assertArcadeGameType, ROOM_TTL_SECONDS, generateInviteCode, generateSeed, roomInclude, createRuntimeState, getArcadeRoomById, getArcadeRoomByInvite, withArcadeRoomLock, patchRuntimeState, normalizeArcadeRoomStatus, getPlayerIds, startOfUtcDay, DAILY_REWARDED_MATCH_CAP, SAME_OPPONENT_DAILY_REWARDED_CAP, COMPLETION_XP, WINNER_BONUS_XP, DRAW_BONUS_XP, isSameUtcDay, isYesterdayUtc, getOpponentId, getResultForUser, getScoreForUser, getScoreForOpponent, MIN_REWARDED_DURATION_SECONDS } from "./arcade-game-types.service";

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
