import type { AuthenticatedRequest as AuthRequest } from "../../../shared/types/authenticated-request";
import { Request, Response } from 'express';
import { prisma } from '../../../config/prisma';
import { CatalogChallenge, clampLimit, codingChallenges, dailyChallengeForDate, matchesQuery, queryText, routeParam } from '../data/growth-hub.catalog';



const serializeChallenge = (challenge: CatalogChallenge, detail = false) => ({
  id: challenge.id,
  slug: challenge.slug,
  title: challenge.title,
  description: challenge.description,
  category: challenge.category,
  difficulty: challenge.difficulty,
  xpReward: challenge.xpReward,
  points: challenge.points,
  ...(detail ? {
    prompt: challenge.prompt,
    starterCode: challenge.starterCode,
    sampleInput: challenge.sampleInput,
    sampleOutput: challenge.sampleOutput,
  } : {}),
});

const findChallenge = (idOrSlug: string | undefined): CatalogChallenge | null => {
  if (!idOrSlug) return null;
  return codingChallenges.find((challenge) => challenge.id === idOrSlug || challenge.slug === idOrSlug) || null;
};

const filteredChallenges = (req: Request): CatalogChallenge[] => {
  const category = queryText(req.query.category);
  const difficulty = queryText(req.query.difficulty).toUpperCase();
  const search = queryText(req.query.search);

  return codingChallenges.filter((challenge) => {
    if (category && challenge.category.toLowerCase() !== category) return false;
    if (difficulty && challenge.difficulty !== difficulty) return false;
    return matchesQuery([challenge.title, challenge.description, challenge.category, challenge.difficulty], search);
  });
};

export const getChallenges = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 20, 50);
    res.json(filteredChallenges(req).slice(0, limit).map((challenge) => serializeChallenge(challenge)));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch challenges' });
  }
};

export const getChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const challenge = findChallenge(routeParam(req.params.slug));
    if (!challenge) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }
    res.json(serializeChallenge(challenge, true));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch challenge' });
  }
};

export const getDailyChallenge = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json(serializeChallenge(dailyChallengeForDate()));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch daily challenge' });
  }
};

export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(Array.from(new Set(codingChallenges.map((challenge) => challenge.category))).sort());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

export const submitSolution = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const challenge = findChallenge(routeParam(req.params.challengeId));
    if (!challenge) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }

    res.status(503).json({
      error: 'Challenge evaluation is temporarily unavailable.',
      code: 'challenge_evaluator_unavailable',
      retryable: true,
      xpEarned: 0,
      coinsEarned: 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit solution' });
  }
};

export const getMySubmissions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const challengeId = typeof req.query.challengeId === 'string' ? req.query.challengeId : undefined;
    const rows = await prisma.xp_transactions.findMany({
      where: {
        userId,
        source: 'challenges',
        type: { in: ['challenge_completed', 'challenge_attempt'] },
        ...(challengeId ? { sourceId: findChallenge(challengeId)?.id || challengeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(rows.map((row) => ({
      id: row.id,
      challengeId: row.sourceId,
      status: row.type === 'challenge_completed' ? 'passed' : 'needs_review',
      xpEarned: row.amount,
      submittedAt: row.createdAt.toISOString(),
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};

export const getLeaderboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 10, 50);
    const users = await prisma.userStats.findMany({
      where: { xp: { gt: 0 } },
      orderBy: [{ xp: 'desc' }, { connectionsCount: 'desc' }],
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            profileImage: true,
          },
        },
      },
    });

    res.json(users.map((stats, index) => ({
      rank: index + 1,
      userId: stats.userId,
      name: stats.user.name,
      username: stats.user.username,
      profileImage: stats.user.profileImage,
      score: stats.xp,
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
};

export const getMyStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [completedRows, attemptedRows, streakRows, rankAhead] = await Promise.all([
      prisma.xp_transactions.findMany({
        where: { userId, source: 'challenges', type: 'challenge_completed' },
      }),
      prisma.xp_transactions.findMany({
        where: { userId, source: 'challenges', type: { in: ['challenge_completed', 'challenge_attempt'] } },
      }),
      prisma.userDailyActivity.findMany({
        where: { userId, isActive: true },
        orderBy: { date: 'desc' },
        take: 30,
      }),
      prisma.userStats.count({
        where: {
          xp: {
            gt: (await prisma.userStats.findUnique({ where: { userId }, select: { xp: true } }))?.xp || 0,
          },
        },
      }),
    ]);

    const completedIds = new Set(completedRows.map((row) => row.sourceId));
    const completedChallenges = codingChallenges.filter((challenge) => completedIds.has(challenge.id));

    res.json({
      totalSolved: completedRows.length,
      totalAttempted: attemptedRows.length,
      easyCount: completedChallenges.filter((challenge) => challenge.difficulty === 'EASY').length,
      mediumCount: completedChallenges.filter((challenge) => challenge.difficulty === 'MEDIUM').length,
      hardCount: completedChallenges.filter((challenge) => challenge.difficulty === 'HARD').length,
      currentStreak: streakRows.length,
      bestStreak: streakRows.length,
      rank: rankAhead + 1,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};

export const runCode = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const challenge = findChallenge(routeParam(req.params.challengeId));
    if (!challenge) {
      res.status(404).json({ error: 'Challenge not found' });
      return;
    }

    res.status(503).json({
      error: 'Challenge evaluation is temporarily unavailable.',
      code: 'challenge_evaluator_unavailable',
      retryable: true,
      passedTests: 0,
      totalTests: 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run code' });
  }
};
