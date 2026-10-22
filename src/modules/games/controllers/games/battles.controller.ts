import { AuthenticatedRequest } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";

/**
 * Create quiz battle
 * POST /api/games/battle/create
 */
export const createQuizBattle = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { category, difficulty } = req.body;

    // Get random questions for the battle
    const questions = await prisma.trivia_questions.findMany({
      where: { isActive: true },
      take: 5,
      orderBy: { timesPlayed: 'asc' },
    });

    const battle = await prisma.quiz_battles.create({
      data: {
        player1Id: userId,
        category,
        difficulty,
        questionIds: questions.map(q => q.id),
        status: 'waiting',
      },
    });

    res.status(200).json({
      battle,
      message: 'Battle created. Waiting for opponent.',
    });
  } catch (error) {
    console.error('Error creating battle:', error);
    res.status(500).json({ error: 'Failed to create battle' });
  }
};

/**
 * Get available battles
 * GET /api/games/battle/available
 */
export const getAvailableBattles = async (
  _req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const battles = await prisma.quiz_battles.findMany({
      where: { status: 'waiting' },
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        users_quiz_battles_player1IdTousers: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
      },
    });

    res.status(200).json({ battles: battles.map(({ users_quiz_battles_player1IdTousers: player1, ...battle }) => ({ ...battle, player1 })) });
  } catch (error) {
    console.error('Error fetching battles:', error);
    res.status(500).json({ error: 'Failed to fetch battles' });
  }
};

/**
 * Join quiz battle
 * POST /api/games/battle/:battleId/join
 */
export const joinQuizBattle = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const battleId = ensureString(req.params.battleId);
    if (!battleId) {
      res.status(400).json({ error: 'Battle ID is required' });
      return;
    }

    const battle = await prisma.quiz_battles.findUnique({
      where: { id: battleId },
    });

    if (!battle) {
      res.status(404).json({ error: 'Battle not found' });
      return;
    }

    if (battle.status !== 'waiting') {
      res.status(400).json({ error: 'Battle is no longer available' });
      return;
    }

    if (battle.player1Id === userId) {
      res.status(400).json({ error: 'Cannot join your own battle' });
      return;
    }

    const updatedBattle = await prisma.quiz_battles.update({
      where: { id: battleId },
      data: {
        player2Id: userId,
        status: 'in_progress',
        startedAt: new Date(),
      },
    });

    res.status(200).json({
      message: 'Joined battle successfully',
      battleId: updatedBattle.id,
    });
  } catch (error) {
    console.error('Error joining battle:', error);
    res.status(500).json({ error: 'Failed to join battle' });
  }
};

/**
 * Get quiz battle
 * GET /api/games/battle/:battleId
 */
export const getQuizBattle = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const battleId = ensureString(req.params.battleId);
    if (!battleId) {
      res.status(400).json({ error: 'Battle ID is required' });
      return;
    }

    const battle = await prisma.quiz_battles.findUnique({
      where: { id: battleId },
      include: {
        users_quiz_battles_player1IdTousers: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
        users_quiz_battles_player2IdTousers: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
      },
    });

    if (!battle) {
      res.status(404).json({ error: 'Battle not found' });
      return;
    }
    if (battle.player1Id !== userId && battle.player2Id !== userId) {
      res.status(404).json({ error: 'Battle not found' });
      return;
    }

    const questionIds = battle.questionIds as string[];
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
      },
    });

    res.status(200).json({
      battle: (({ users_quiz_battles_player1IdTousers: player1, users_quiz_battles_player2IdTousers: player2, ...fields }) => ({ ...fields, player1, player2 }))(battle),
      questions,
      isPlayer1: userId === battle.player1Id,
      isPlayer2: userId === battle.player2Id,
    });
  } catch (error) {
    console.error('Error fetching battle:', error);
    res.status(500).json({ error: 'Failed to fetch battle' });
  }
};

/**
 * Answer quiz battle question
 * POST /api/games/battle/:battleId/answer
 */
export const answerBattleQuestion = async (
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const battleId = ensureString(req.params.battleId);
    if (!battleId) {
      res.status(400).json({ error: 'Battle ID is required' });
      return;
    }
    const { questionId, selectedIndex } = req.body;

    const battle = await prisma.quiz_battles.findUnique({
      where: { id: battleId },
    });

    if (!battle) {
      res.status(404).json({ error: 'Battle not found' });
      return;
    }
    if (battle.player1Id !== userId && battle.player2Id !== userId) {
      res.status(404).json({ error: 'Battle not found' });
      return;
    }

    const qId = ensureString(questionId);
    if (!qId) {
      res.status(400).json({ error: 'Question ID is required' });
      return;
    }
    const battleQuestionIds = Array.isArray(battle.questionIds) ? battle.questionIds.map(String) : [];
    if (!battleQuestionIds.includes(qId)) {
      res.status(400).json({ error: 'Question does not belong to this battle' });
      return;
    }

    const question = await prisma.trivia_questions.findUnique({
      where: { id: qId },
    });

    if (!question) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }

    const isCorrect = selectedIndex === question.correctIndex;

    res.status(200).json({
      isCorrect,
      correctIndex: question.correctIndex,
    });
  } catch (error) {
    console.error('Error answering battle question:', error);
    res.status(500).json({ error: 'Failed to answer question' });
  }
};
