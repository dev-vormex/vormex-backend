import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { awardUserProgress } from '../services/progress.service';
import {
  CatalogLearningPath,
  clampLimit,
  findLearningLesson,
  findLearningQuiz,
  learningPaths,
  matchesQuery,
  queryText,
  routeParam,
} from '../data/growth-hub.catalog';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const pathSummary = (path: CatalogLearningPath) => ({
  id: path.id,
  slug: path.slug,
  title: path.title,
  description: path.description,
  category: path.category,
  difficulty: path.difficulty,
  estimatedHours: path.estimatedHours,
  xpReward: path.xpReward,
  thumbnail: path.thumbnail || null,
  isFeatured: path.isFeatured,
});

const pathDetail = (path: CatalogLearningPath) => ({
  ...pathSummary(path),
  lessons: path.lessons,
  quiz: {
    id: path.quiz.id,
    title: path.quiz.title,
    passingScore: path.quiz.passingScore,
    questionCount: path.quiz.questions.length,
    questions: path.quiz.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options,
    })),
  },
});

const findPath = (idOrSlug: string | undefined): CatalogLearningPath | null => {
  if (!idOrSlug) return null;
  return learningPaths.find((path) => path.id === idOrSlug || path.slug === idOrSlug) || null;
};

const filteredPaths = (req: Request): CatalogLearningPath[] => {
  const category = queryText(req.query.category);
  const difficulty = queryText(req.query.difficulty);
  const search = queryText(req.query.search);

  return learningPaths.filter((path) => {
    if (category && path.category.toLowerCase() !== category) return false;
    if (difficulty && path.difficulty.toLowerCase() !== difficulty) return false;
    return matchesQuery([path.title, path.description, path.category, path.difficulty], search);
  });
};

const safeCreateMarker = async (input: {
  userId: string;
  type: string;
  sourceId: string;
  description: string;
}) => {
  const idempotencyKey = `${input.userId}:${input.type}:${input.sourceId}`;
  try {
    return await prisma.xp_transactions.upsert({
      where: { idempotencyKey },
      create: {
        userId: input.userId,
        amount: 0,
        type: input.type,
        source: 'learning',
        sourceId: input.sourceId,
        description: input.description,
        currency: 'XP',
        countsForStreak: false,
        idempotencyKey,
      },
      update: {
        description: input.description,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.xp_transactions.findUnique({ where: { idempotencyKey } });
    }
    throw error;
  }
};

export const getLearningPaths = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 20, 50);
    res.json(filteredPaths(req).slice(0, limit).map(pathSummary));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch learning paths' });
  }
};

export const getLearningPath = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const path = findPath(routeParam(req.params.slug));
    if (!path) {
      res.status(404).json({ error: 'Learning path not found' });
      return;
    }
    res.json(pathDetail(path));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch learning path' });
  }
};

export const getFeaturedPaths = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const limit = clampLimit(req.query.limit, 5, 20);
    res.json(learningPaths.filter((path) => path.isFeatured).slice(0, limit).map(pathSummary));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch featured paths' });
  }
};

export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(Array.from(new Set(learningPaths.map((path) => path.category))).sort());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

export const enrollInPath = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const pathId = typeof req.body?.pathId === 'string' ? req.body.pathId : '';
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const path = findPath(pathId);
    if (!path) {
      res.status(404).json({ error: 'Learning path not found' });
      return;
    }

    const marker = await safeCreateMarker({
      userId,
      type: 'learning_enrollment',
      sourceId: path.id,
      description: `Enrolled in ${path.title}`,
    });

    res.json({
      success: true,
      message: 'Enrolled successfully!',
      enrollment: {
        id: marker?.id || `${userId}:${path.id}`,
        path: pathSummary(path),
        enrolledAt: marker?.createdAt?.toISOString?.() || new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to enroll' });
  }
};

export const getMyEnrollments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rows = await prisma.xp_transactions.findMany({
      where: { userId, type: 'learning_enrollment', source: 'learning' },
      orderBy: { createdAt: 'desc' },
    });

    res.json(rows.map((row) => {
      const path = findPath(row.sourceId || '');
      return path ? {
        id: row.id,
        path: pathSummary(path),
        enrolledAt: row.createdAt.toISOString(),
      } : null;
    }).filter(Boolean));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
};

export const dropEnrollment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const path = findPath(routeParam(req.params.pathId));
    if (!path) {
      res.status(404).json({ error: 'Learning path not found' });
      return;
    }

    await prisma.xp_transactions.deleteMany({
      where: { userId, type: 'learning_enrollment', source: 'learning', sourceId: path.id },
    });

    res.json({ success: true, message: 'Enrollment dropped' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to drop enrollment' });
  }
};

export const getLesson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = findLearningLesson(routeParam(req.params.lessonId) || '');
    if (!result) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    res.json({
      ...result.lesson,
      path: pathSummary(result.path),
      nextLessonId: result.path.lessons.find((lesson) => lesson.order === result.lesson.order + 1)?.id || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch lesson' });
  }
};

export const completeLesson = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = findLearningLesson(routeParam(req.params.lessonId) || '');
    if (!result) {
      res.status(404).json({ error: 'Lesson not found' });
      return;
    }

    const progress = await awardUserProgress({
      userId,
      xpAmount: result.lesson.xpReward,
      coinAmount: Math.max(5, Math.floor(result.lesson.xpReward / 5)),
      type: 'learning_lesson_complete',
      source: 'learning',
      sourceId: result.lesson.id,
      description: `Completed ${result.lesson.title}`,
      countsForStreak: true,
      idempotencyKey: `${userId}:learning_lesson_complete:${result.lesson.id}`,
    });

    res.json({
      success: true,
      xpEarned: progress.xpAmount,
      coinsEarned: progress.coinAmount,
      message: progress.xpAwarded ? 'Lesson completed!' : 'Lesson was already completed.',
      path: pathSummary(result.path),
      nextLessonId: result.path.lessons.find((lesson) => lesson.order === result.lesson.order + 1)?.id || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete lesson' });
  }
};

export const submitQuiz = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const quizId = typeof req.body?.quizId === 'string' ? req.body.quizId : '';
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const result = findLearningQuiz(quizId);
    if (!result) {
      res.status(404).json({ error: 'Quiz not found' });
      return;
    }

    let correct = 0;
    result.quiz.questions.forEach((question, index) => {
      const answer = answers[index];
      const selectedIndex = typeof answer === 'number'
        ? answer
        : typeof answer?.selectedIndex === 'number'
          ? answer.selectedIndex
          : -1;
      if (selectedIndex === question.correctIndex) correct += 1;
    });

    const totalQuestions = result.quiz.questions.length;
    const score = totalQuestions === 0 ? 0 : Math.round((correct / totalQuestions) * 100);
    const passed = score >= result.quiz.passingScore;
    const reward = passed ? result.path.xpReward : Math.max(5, Math.floor(result.path.xpReward / 6));
    const progress = await awardUserProgress({
      userId,
      xpAmount: reward,
      coinAmount: passed ? Math.max(10, Math.floor(reward / 5)) : 0,
      type: passed ? 'learning_quiz_passed' : 'learning_quiz_attempt',
      source: 'learning',
      sourceId: result.quiz.id,
      description: `${result.quiz.title}: ${score}%`,
      countsForStreak: passed,
      idempotencyKey: passed ? `${userId}:learning_quiz_passed:${result.quiz.id}` : undefined,
    });

    res.json({
      score,
      correct,
      totalQuestions,
      passed,
      xpEarned: progress.xpAmount,
      coinsEarned: progress.coinAmount,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
};

export const getQuizAttempts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const quizId = routeParam(req.params.quizId) || '';
    const rows = await prisma.xp_transactions.findMany({
      where: {
        userId,
        source: 'learning',
        sourceId: quizId,
        type: { in: ['learning_quiz_passed', 'learning_quiz_attempt'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(rows.map((row) => ({
      id: row.id,
      quizId,
      passed: row.type === 'learning_quiz_passed',
      xpEarned: row.amount,
      description: row.description,
      createdAt: row.createdAt.toISOString(),
    })));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quiz attempts' });
  }
};
