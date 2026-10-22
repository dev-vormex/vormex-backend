import { prisma } from "../../../../config/prisma";
import { normalizeGameType } from "./arcade-game-types.service";

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
