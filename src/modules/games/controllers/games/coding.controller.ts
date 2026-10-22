import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";

/**
 * Get coding problems
 * GET /api/games/coding/problems
 */
export const getCodingProblems = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const { category, difficulty, limit = 20 } = req.query;
    
    const where: any = { isActive: true };
    if (category) where.category = category;
    if (difficulty) where.difficulty = difficulty;

    const problems = await prisma.coding_problems.findMany({
      where,
      take: Math.min(50, Number(limit)),
      select: {
        id: true,
        title: true,
        description: true,
        difficulty: true,
        category: true,
        xpReward: true,
        timesAttempted: true,
        timesSolved: true,
      },
    });

    res.status(200).json({ problems });
  } catch (error) {
    console.error('Error fetching coding problems:', error);
    res.status(500).json({ error: 'Failed to fetch problems' });
  }
};

/**
 * Get coding problem by ID
 * GET /api/games/coding/problems/:problemId
 */
export const getCodingProblem = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const problemId = ensureString(req.params.problemId);
    if (!problemId) {
      res.status(400).json({ error: 'Problem ID is required' });
      return;
    }
    const userId = req.user?.userId;

    const problem = await prisma.coding_problems.findUnique({
      where: { id: problemId },
    });

    if (!problem) {
      res.status(404).json({ error: 'Problem not found' });
      return;
    }

    const submissions = userId
      ? await prisma.coding_submissions.findMany({
          where: { userId: String(userId), problemId },
          orderBy: { submittedAt: 'desc' },
          take: 10,
        })
      : [];

    res.status(200).json({ problem, submissions });
  } catch (error) {
    console.error('Error fetching coding problem:', error);
    res.status(500).json({ error: 'Failed to fetch problem' });
  }
};

/**
 * Submit coding solution
 * POST /api/games/coding/problems/:problemId/submit
 */
export const submitCodingSolution = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const problemId = ensureString(req.params.problemId);
    if (!problemId) {
      res.status(400).json({ error: 'Problem ID is required' });
      return;
    }
    const { code, language } = req.body;

    const problem = await prisma.coding_problems.findUnique({
      where: { id: problemId },
    });

    if (!problem) {
      res.status(404).json({ error: 'Problem not found' });
      return;
    }

    // For now, return a placeholder response
    // In production, this would run the code against test cases
    const submission = await prisma.coding_submissions.create({
      data: {
        userId,
        problemId,
        code,
        language,
        status: 'pending',
        passedTests: 0,
        totalTests: 0,
      },
    });

    res.status(200).json({
      submission,
      testResults: [],
      xpEarned: 0,
    });
  } catch (error) {
    console.error('Error submitting solution:', error);
    res.status(500).json({ error: 'Failed to submit solution' });
  }
};
