import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { awardUserProgress } from "../../../engagement/services/progress.service";

/**
 * Get daily trivia
 * GET /api/games/trivia/daily
 */
export const getDailyTrivia = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let session = await prisma.daily_trivia_sessions.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    if (session?.completedAt) {
      res.status(200).json({
        status: 'completed',
        session: {
          id: session.id,
          date: session.date.toISOString(),
          correctCount: session.correctCount,
          totalQuestions: session.totalQuestions,
          totalXpEarned: session.totalXpEarned,
          completedAt: session.completedAt.toISOString(),
        },
        message: 'You have already completed today\'s trivia. Come back tomorrow!',
      });
      return;
    }

    if (!session) {
      const questions = await prisma.trivia_questions.findMany({
        where: { isActive: true },
        take: 5,
        orderBy: { timesPlayed: 'asc' },
      });

      if (questions.length < 5) {
        res.status(200).json({
          status: 'no_questions',
          message: 'Not enough trivia questions available. Please try again later.',
        });
        return;
      }

      session = await prisma.daily_trivia_sessions.create({
        data: {
          userId,
          date: today,
          questionsIds: questions.map((q) => q.id),
          totalQuestions: 5,
        },
      });
    }

    const questionIds = session.questionsIds as string[];
    const questions = await prisma.trivia_questions.findMany({
      where: { id: { in: questionIds } },
      select: {
        id: true,
        question: true,
        options: true,
        category: true,
        difficulty: true,
        xpReward: true,
        timeLimit: true,
        imageUrl: true,
      },
    });

    const attempts = await prisma.trivia_attempts.findMany({
      where: { userId, questionId: { in: questionIds } },
    });

    const attemptedIds = new Set(attempts.map((a) => a.questionId));

    res.status(200).json({
      status: 'in_progress',
      session: {
        id: session.id,
        date: session.date.toISOString(),
        correctCount: session.correctCount,
        totalQuestions: session.totalQuestions,
        totalXpEarned: session.totalXpEarned,
      },
      questions: questions.map((q) => ({
        ...q,
        isAnswered: attemptedIds.has(q.id),
      })),
      progress: {
        answered: attempts.length,
        total: session.totalQuestions,
        correct: session.correctCount,
      },
    });
  } catch (error) {
    console.error('Error getting daily trivia:', error);
    res.status(500).json({ error: 'Failed to get daily trivia' });
  }
};

/**
 * Answer trivia question
 * POST /api/games/trivia/answer
 */
export const answerTriviaQuestion = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { questionId, selectedIndex, timeSpent } = req.body;

    if (!questionId || selectedIndex === undefined) {
      res.status(400).json({ error: 'questionId and selectedIndex are required' });
      return;
    }

    const question = await prisma.trivia_questions.findUnique({
      where: { id: questionId },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    const existingAttempt = await prisma.trivia_attempts.findUnique({
      where: { userId_questionId: { userId, questionId } },
    });

    if (existingAttempt) {
      res.status(400).json({ error: 'Question already answered' });
      return;
    }

    const isCorrect = selectedIndex === question.correctIndex;
    const xpEarned = isCorrect ? question.xpReward : 0;

    await prisma.$transaction([
      prisma.trivia_attempts.create({
        data: {
          userId,
          questionId,
          selectedIndex,
          isCorrect,
          timeSpent: timeSpent || 0,
          xpEarned,
        },
      }),
      prisma.trivia_questions.update({
        where: { id: questionId },
        data: {
          timesPlayed: { increment: 1 },
          timesCorrect: { increment: isCorrect ? 1 : 0 },
        },
      }),
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.daily_trivia_sessions.update({
      where: { userId_date: { userId, date: today } },
      data: {
        correctCount: { increment: isCorrect ? 1 : 0 },
        totalXpEarned: { increment: xpEarned },
      },
    });

    if (isCorrect && xpEarned > 0) {
      await awardUserProgress({
        userId,
        xpAmount: xpEarned,
        coinAmount: xpEarned,
        type: 'trivia_correct',
        source: 'daily_trivia',
        sourceId: questionId,
        description: 'Correct trivia answer',
        countsForStreak: true,
        idempotencyKey: `${userId}:daily_trivia:${questionId}`,
      });
    }

    res.status(200).json({
      isCorrect,
      correctIndex: question.correctIndex,
      explanation: question.explanation,
      xpEarned,
    });
  } catch (error) {
    console.error('Error answering trivia:', error);
    res.status(500).json({ error: 'Failed to submit answer' });
  }
};

/**
 * Get trivia questions
 * GET /api/games/trivia/questions
 */
export const getTriviaQuestions = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const { category, difficulty, limit = 10 } = req.query;
    
    const where: any = { isActive: true };
    if (category) where.category = category;
    if (difficulty) where.difficulty = difficulty;

    const questions = await prisma.trivia_questions.findMany({
      where,
      take: Math.min(50, Number(limit)),
      select: {
        id: true,
        question: true,
        options: true,
        category: true,
        difficulty: true,
        xpReward: true,
        timeLimit: true,
        imageUrl: true,
      },
    });

    res.status(200).json({ questions });
  } catch (error) {
    console.error('Error fetching trivia questions:', error);
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
};
