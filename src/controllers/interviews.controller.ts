import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { awardUserProgress } from '../services/progress.service';
import {
  categoryQuestionCount,
  clampLimit,
  interviewCategories,
  interviewQuestions,
  matchesQuery,
  queryText,
  routeParam,
} from '../data/growth-hub.catalog';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const serializeCategory = (category: typeof interviewCategories[number]) => ({
  id: category.id,
  name: category.name,
  slug: category.slug,
  description: category.description,
  questionCount: categoryQuestionCount(category.id),
  order: category.order,
});

const serializeQuestion = (question: typeof interviewQuestions[number]) => {
  const category = interviewCategories.find((item) => item.id === question.categoryId);
  return {
    id: question.id,
    categoryId: question.categoryId,
    categorySlug: category?.slug || null,
    title: question.title,
    prompt: question.prompt,
    difficulty: question.difficulty,
    expectedSignals: question.expectedSignals,
  };
};

const findCategory = (idOrSlug: string | undefined) => {
  if (!idOrSlug) return null;
  return interviewCategories.find((category) => category.id === idOrSlug || category.slug === idOrSlug) || null;
};

const findQuestion = (questionId: string | undefined) => {
  if (!questionId) return null;
  return interviewQuestions.find((question) => question.id === questionId) || null;
};

const filteredQuestions = (req: Request) => {
  const categoryInput = queryText(req.query.categoryId || req.query.category || req.query.categorySlug);
  const difficulty = queryText(req.query.difficulty);
  const search = queryText(req.query.search);
  const category = findCategory(categoryInput);

  return interviewQuestions.filter((question) => {
    if (category && question.categoryId !== category.id) return false;
    if (!category && categoryInput && question.categoryId.toLowerCase() !== categoryInput) return false;
    if (difficulty && question.difficulty.toLowerCase() !== difficulty) return false;
    return matchesQuery([question.title, question.prompt, question.difficulty, ...question.expectedSignals], search);
  });
};

export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(interviewCategories.map(serializeCategory).sort((a, b) => a.order - b.order));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

export const getCategoryBySlug = async (req: Request, res: Response): Promise<void> => {
  try {
    const category = findCategory(routeParam(req.params.slug));
    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    res.json({
      ...serializeCategory(category),
      questions: interviewQuestions
        .filter((question) => question.categoryId === category.id)
        .map(serializeQuestion),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch category' });
  }
};

export const getQuestions = async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 20, 100);
    res.json(filteredQuestions(req).slice(0, limit).map(serializeQuestion));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
};

export const getQuestion = async (req: Request, res: Response): Promise<void> => {
  try {
    const question = findQuestion(routeParam(req.params.questionId));
    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    res.json(serializeQuestion(question));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch question' });
  }
};

export const startSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const category = findCategory(req.body?.categoryId || req.body?.categorySlug) || interviewCategories[0];
    const difficulty = queryText(req.body?.difficulty).toUpperCase() || 'MEDIUM';
    const questionCount = Math.min(10, Math.max(1, Number(req.body?.questionCount) || 3));
    const pool = interviewQuestions.filter((question) => {
      if (question.categoryId !== category.id) return false;
      return !difficulty || question.difficulty === difficulty || difficulty === 'MIXED';
    });
    const selectedQuestions = (pool.length ? pool : interviewQuestions.filter((question) => question.categoryId === category.id))
      .slice(0, questionCount);
    const sessionId = `interview:${category.slug}:${Date.now()}`;

    res.json({
      session: {
        id: sessionId,
        categoryId: category.id,
        categorySlug: category.slug,
        difficulty,
        questionCount: selectedQuestions.length,
        duration: Number(req.body?.duration) || selectedQuestions.length * 8,
        status: 'in_progress',
        startedAt: new Date().toISOString(),
      },
      questions: selectedQuestions.map(serializeQuestion),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start session' });
  }
};

export const getMySessions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rows = await prisma.xp_transactions.findMany({
      where: { userId, source: 'interviews', type: 'interview_session_complete' },
      orderBy: { createdAt: 'desc' },
    });

    res.json(rows.map((row) => ({
      id: row.sourceId || row.id,
      status: 'completed',
      score: Number(row.description?.match(/score=(\d+)/)?.[1] || 0),
      xpEarned: row.amount,
      completedAt: row.createdAt.toISOString(),
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
};

export const getSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sessionId = routeParam(req.params.sessionId) || '';
    const categorySlug = sessionId.split(':')[1];
    const category = findCategory(categorySlug);
    if (!category) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const questions = interviewQuestions
      .filter((question) => question.categoryId === category.id)
      .slice(0, 5);

    res.json({
      session: {
        id: sessionId,
        categoryId: category.id,
        categorySlug: category.slug,
        status: 'in_progress',
      },
      questions: questions.map(serializeQuestion),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
};

export const submitResponse = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const question = findQuestion(req.body?.questionId);
    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';
    const matchedSignals = question.expectedSignals.filter((signal) =>
      answer.toLowerCase().includes(signal.split(' ')[0].toLowerCase())
    );
    const score = Math.min(100, Math.max(35, 45 + matchedSignals.length * 18 + Math.min(20, Math.floor(answer.length / 40))));

    res.json({
      success: true,
      score,
      feedback: {
        summary: matchedSignals.length > 0
          ? 'Good structure. You named relevant signals for this question.'
          : 'Add more concrete tradeoffs, examples, and outcome details.',
        matchedSignals,
        suggestedSignals: question.expectedSignals.filter((signal) => !matchedSignals.includes(signal)),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit response' });
  }
};

export const completeSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = routeParam(req.params.sessionId) || '';
    const score = Math.min(100, Math.max(0, Number(req.body?.score) || 80));
    const xpReward = score >= 75 ? 45 : 20;
    const progress = await awardUserProgress({
      userId,
      xpAmount: xpReward,
      coinAmount: score >= 75 ? 10 : 0,
      type: 'interview_session_complete',
      source: 'interviews',
      sourceId: sessionId,
      description: `score=${score}`,
      countsForStreak: true,
      idempotencyKey: `${userId}:interview_session_complete:${sessionId}`,
    });

    res.json({
      success: true,
      score,
      xpEarned: progress.xpAmount,
      coinsEarned: progress.coinAmount,
      feedback: score >= 75
        ? 'Strong practice session. Keep building answer depth with specific examples.'
        : 'Session complete. Review the expected signals and try one more focused pass.',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete session' });
  }
};

export const getMyStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rows = await prisma.xp_transactions.findMany({
      where: { userId, source: 'interviews', type: 'interview_session_complete' },
      orderBy: { createdAt: 'desc' },
    });
    const scores = rows
      .map((row) => Number(row.description?.match(/score=(\d+)/)?.[1] || 0))
      .filter((score) => score > 0);
    const averageScore = scores.length
      ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : 0;

    res.json({
      totalSessions: rows.length,
      completedSessions: rows.length,
      averageScore,
      strongCategories: averageScore >= 75 ? ['Communication', 'Problem framing'] : [],
      weakCategories: averageScore > 0 && averageScore < 75 ? ['Specific examples', 'Tradeoffs'] : [],
      totalTimeSpent: rows.length * 20,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};
