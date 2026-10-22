import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { GameStats, XPTransaction, LeaderboardEntry } from "./support.controller";

/**
 * Get current user's game stats
 * GET /api/games/stats
 */
export const getMyGameStats = async (
  req: AuthenticatedRequest,
  res: Response<{ stats: GameStats } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);

    let gameStats = await prisma.game_stats.findUnique({
      where: { userId },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coinsBalance: true, xpBalance: true },
    });

    if (!gameStats) {
      gameStats = await prisma.game_stats.create({
        data: { userId },
      });
    }

    const stats: GameStats = {
      id: gameStats.id,
      userId: gameStats.userId,
      totalGamesPlayed: gameStats.totalGamesPlayed,
      totalXpEarned: gameStats.totalXpEarned,
      currentStreak: gameStats.currentStreak,
      longestStreak: gameStats.bestStreak,
      lastPlayedAt: gameStats.lastPlayedAt?.toISOString() || null,
      triviaGamesPlayed: gameStats.triviaGamesPlayed,
      triviaCorrectAnswers: gameStats.triviaCorrectAnswers,
      triviaTotalQuestions: gameStats.triviaTotalQuestions,
      triviaHighScore: 0,
      codingProblemsAttempted: gameStats.codingProblemsAttempted,
      codingProblemsSolved: gameStats.codingProblemsSolved,
      codingTotalSubmissions: gameStats.codingTotalSubmissions,
      wordleGamesPlayed: gameStats.wordleGamesPlayed,
      wordleGamesWon: gameStats.wordleGamesWon,
      wordleCurrentStreak: gameStats.wordleCurrentStreak,
      wordleBestStreak: gameStats.wordleBestStreak,
      wordleAverageAttempts: gameStats.wordleAverageAttempts,
      quizBattlesPlayed: gameStats.quizBattlesPlayed,
      quizBattlesWon: gameStats.quizBattlesWon,
      quizBattleWinRate: gameStats.quizBattlesPlayed > 0
        ? (gameStats.quizBattlesWon / gameStats.quizBattlesPlayed) * 100
        : 0,
      typingRacesCompleted: gameStats.typingGamesPlayed,
      typingBestWpm: gameStats.typingBestWpm,
      typingAverageWpm: gameStats.typingAverageWpm,
      typingBestAccuracy: gameStats.typingBestAccuracy,
      currentXpBalance: user?.coinsBalance || user?.xpBalance || 0,
      currentCoinsBalance: user?.coinsBalance || user?.xpBalance || 0,
    };

    res.status(200).json({ stats });
  } catch (error) {
    console.error('Error fetching game stats:', error);
    res.status(500).json({ error: 'Failed to fetch game stats' });
  }
};

/**
 * Get XP transaction history
 * GET /api/games/xp-history
 */
export const getXPHistory = async (
  req: AuthenticatedRequest,
  res: Response<{ transactions: XPTransaction[]; nextCursor: string | null; hasMore: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const cursor = req.query.cursor as string | undefined;

    const transactions = await prisma.xp_transactions.findMany({
      where: { userId },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
    });

    const hasMore = transactions.length > limit;
    const resultTransactions = hasMore ? transactions.slice(0, -1) : transactions;
    const nextCursor = hasMore ? resultTransactions[resultTransactions.length - 1]?.id : null;

    res.status(200).json({
      transactions: resultTransactions.map((t) => ({
        id: t.id,
        userId: t.userId,
        amount: t.amount,
        type: t.type,
        source: t.source,
        sourceId: t.sourceId || undefined,
        description: t.description || undefined,
        createdAt: t.createdAt.toISOString(),
        currency: t.currency,
        countsForStreak: t.countsForStreak,
      })),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error('Error fetching XP history:', error);
    res.status(500).json({ error: 'Failed to fetch XP history' });
  }
};

/**
 * Get leaderboard
 * GET /api/games/leaderboard
 */
export const getLeaderboard = async (
  req: AuthenticatedRequest,
  res: Response<{ leaderboard: LeaderboardEntry[] } | ErrorResponse>
): Promise<void> => {
  try {
    const period = (req.query.period as string) || 'alltime';
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    let dateFilter: Date | undefined;
    if (period === 'daily') {
      dateFilter = new Date();
      dateFilter.setHours(0, 0, 0, 0);
    } else if (period === 'weekly') {
      dateFilter = new Date();
      dateFilter.setDate(dateFilter.getDate() - 7);
    } else if (period === 'monthly') {
      dateFilter = new Date();
      dateFilter.setMonth(dateFilter.getMonth() - 1);
    }

    const gameStatsAll = await prisma.game_stats.findMany({
      take: limit,
      orderBy: { totalXpEarned: 'desc' },
    });

    const userIds = gameStatsAll.map((g) => g.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, username: true, profileImage: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    const leaderboard: LeaderboardEntry[] = gameStatsAll
      .filter((g) => userMap.has(g.userId))
      .map((g, index) => {
        const user = userMap.get(g.userId)!;
        return {
          rank: index + 1,
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            profileImage: user.profileImage,
          },
          xp: g.totalXpEarned,
          gamesPlayed: g.totalGamesPlayed,
          streak: g.currentStreak,
        };
      });

    res.status(200).json({ leaderboard });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};
