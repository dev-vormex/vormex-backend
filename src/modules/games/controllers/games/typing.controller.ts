import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { awardUserProgress } from "../../../engagement/services/progress.service";

/**
 * Get typing texts
 * GET /api/games/typing/texts
 */
export const getTypingTexts = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const category = ensureString(req.query.category);
    const difficulty = ensureString(req.query.difficulty);
    const limit = parseInt(ensureString(req.query.limit) || '10') || 10;
    
    const where: any = { isActive: true };
    if (category) where.category = category;
    if (difficulty) where.difficulty = difficulty;

    const texts = await prisma.typing_texts.findMany({
      where,
      take: Math.min(50, limit),
    });

    res.status(200).json({ texts });
  } catch (error) {
    console.error('Error fetching typing texts:', error);
    res.status(500).json({ error: 'Failed to fetch texts' });
  }
};

/**
 * Start typing race
 * POST /api/games/typing/start
 */
export const startTypingRace = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const textId = ensureString(req.body.textId);
    if (!textId) {
      res.status(400).json({ error: 'Text ID is required' });
      return;
    }

    const text = await prisma.typing_texts.findUnique({
      where: { id: textId },
    });

    if (!text) {
      res.status(404).json({ error: 'Text not found' });
      return;
    }

    const race = await prisma.typing_races.create({
      data: {
        userId,
        textId,
        status: 'playing',
      },
    });

    res.status(200).json({ race, text });
  } catch (error) {
    console.error('Error starting typing race:', error);
    res.status(500).json({ error: 'Failed to start race' });
  }
};

/**
 * Finish typing race
 * POST /api/games/typing/:raceId/finish
 */
export const finishTypingRace = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const raceId = ensureString(req.params.raceId);
    if (!raceId) {
      res.status(400).json({ error: 'Race ID is required' });
      return;
    }
    const { wpm, accuracy, timeSpent, mistakes } = req.body;

    const race = await prisma.typing_races.findUnique({
      where: { id: raceId },
      include: { typing_texts: true },
    });

    if (!race || race.userId !== userId) {
      res.status(404).json({ error: 'Race not found' });
      return;
    }

    if (race.status === 'completed') {
      res.status(400).json({ error: 'Race already completed' });
      return;
    }

    const xpEarned = Math.floor(wpm * accuracy / 100);

    await prisma.typing_races.update({
      where: { id: raceId },
      data: {
        wpm,
        accuracy,
        timeSpent,
        mistakes,
        status: 'completed',
        xpEarned,
        completedAt: new Date(),
      },
    });

    if (xpEarned > 0) {
      await awardUserProgress({
        userId,
        xpAmount: xpEarned,
        coinAmount: xpEarned,
        type: 'typing_race_complete',
        source: 'typing_race',
        sourceId: raceId,
        description: 'Completed typing race',
        countsForStreak: true,
        idempotencyKey: `${userId}:typing_race:${raceId}`,
      });
    }

    // Get current user stats to check for personal best
    const gameStats = await prisma.game_stats.findUnique({
      where: { userId },
    });

    const isPersonalBest = !gameStats || wpm > gameStats.typingBestWpm;

    // Update game stats
    await prisma.game_stats.upsert({
      where: { userId },
      create: {
        userId,
        typingGamesPlayed: 1,
        typingBestWpm: wpm,
        typingAverageWpm: wpm,
        typingBestAccuracy: accuracy,
      },
      update: {
        typingGamesPlayed: { increment: 1 },
        typingBestWpm: isPersonalBest ? wpm : undefined,
        typingBestAccuracy: accuracy > (gameStats?.typingBestAccuracy || 0) ? accuracy : undefined,
      },
    });

    res.status(200).json({
      wpm,
      accuracy,
      xpEarned,
      isPersonalBest,
    });
  } catch (error) {
    console.error('Error finishing typing race:', error);
    res.status(500).json({ error: 'Failed to finish race' });
  }
};

/**
 * Get typing history
 * GET /api/games/typing/history
 */
export const getTypingHistory = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const limit = Math.min(50, Number(req.query.limit) || 20);

    const races = await prisma.typing_races.findMany({
      where: { userId, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      take: limit,
      include: {
        typing_texts: {
          select: { title: true, category: true, difficulty: true },
        },
      },
    });

    res.status(200).json({ races: races.map(({ typing_texts: text, ...race }) => ({ ...race, text })) });
  } catch (error) {
    console.error('Error fetching typing history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
};
