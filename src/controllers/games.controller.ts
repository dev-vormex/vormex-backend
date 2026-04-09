// @ts-nocheck
import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';

interface GameStats {
  id: string;
  userId: string;
  totalGamesPlayed: number;
  totalXpEarned: number;
  currentStreak: number;
  longestStreak: number;
  lastPlayedAt: string | null;
  triviaGamesPlayed: number;
  triviaCorrectAnswers: number;
  triviaTotalQuestions: number;
  triviaHighScore: number;
  codingProblemsAttempted: number;
  codingProblemsSolved: number;
  codingTotalSubmissions: number;
  wordleGamesPlayed: number;
  wordleGamesWon: number;
  wordleCurrentStreak: number;
  wordleBestStreak: number;
  wordleAverageAttempts: number;
  quizBattlesPlayed: number;
  quizBattlesWon: number;
  quizBattleWinRate: number;
  typingRacesCompleted: number;
  typingBestWpm: number;
  typingAverageWpm: number;
  typingBestAccuracy: number;
  currentXpBalance: number;
}

interface LeaderboardEntry {
  rank: number;
  user: {
    id: string;
    name: string;
    username: string;
    profileImage: string | null;
  };
  xp: number;
  gamesPlayed: number;
  streak: number;
}

interface XPTransaction {
  id: string;
  userId: string;
  amount: number;
  type: string;
  source: string;
  sourceId?: string;
  description?: string;
  createdAt: string;
}

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
      select: { xpBalance: true },
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
      currentXpBalance: user?.xpBalance || 0,
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
    const gameType = req.query.gameType as string | undefined;
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
      ...(isCorrect
        ? [
            prisma.user.update({
              where: { id: userId },
              data: { xpBalance: { increment: xpEarned } },
            }),
            prisma.xp_transactions.create({
              data: {
                userId,
                amount: xpEarned,
                type: 'trivia_correct',
                source: 'daily_trivia',
                sourceId: questionId,
                description: 'Correct trivia answer',
              },
            }),
          ]
        : []),
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
 * Get daily wordle
 * GET /api/games/wordle/daily
 */
export const getDailyWordle = async (
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

    const todaysWord = await prisma.wordle_words.findFirst({
      where: { usedOnDate: today },
    });

    if (!todaysWord) {
      const unusedWord = await prisma.wordle_words.findFirst({
        where: { usedOnDate: null, isActive: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!unusedWord) {
        res.status(200).json({
          error: 'No wordle words available',
          message: 'Please try again later.',
        });
        return;
      }

      await prisma.wordle_words.update({
        where: { id: unusedWord.id },
        data: { usedOnDate: today },
      });

      const game = await prisma.wordle_games.create({
        data: {
          userId,
          wordId: unusedWord.id,
          guesses: [],
        },
      });

      res.status(200).json({
        game: {
          id: game.id,
          status: game.status,
          guesses: [],
          attempts: 0,
          maxAttempts: game.maxAttempts,
          xpEarned: 0,
          startedAt: game.startedAt.toISOString(),
        },
        hint: unusedWord.hint,
        wordLength: unusedWord.word.length,
      });
      return;
    }

    let game = await prisma.wordle_games.findFirst({
      where: { userId, wordId: todaysWord.id },
    });

    if (!game) {
      game = await prisma.wordle_games.create({
        data: {
          userId,
          wordId: todaysWord.id,
          guesses: [],
        },
      });
    }

    res.status(200).json({
      game: {
        id: game.id,
        status: game.status,
        guesses: game.guesses,
        attempts: game.attempts,
        maxAttempts: game.maxAttempts,
        xpEarned: game.xpEarned,
        startedAt: game.startedAt.toISOString(),
        completedAt: game.completedAt?.toISOString(),
        ...(game.status !== 'playing' ? { word: todaysWord.word } : {}),
      },
      hint: todaysWord.hint,
      wordLength: todaysWord.word.length,
    });
  } catch (error) {
    console.error('Error getting daily wordle:', error);
    res.status(500).json({ error: 'Failed to get daily wordle' });
  }
};

/**
 * Submit wordle guess
 * POST /api/games/wordle/guess
 */
export const guessWordle = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { gameId, guess } = req.body;

    if (!gameId || !guess) {
      res.status(400).json({ error: 'gameId and guess are required' });
      return;
    }

    const game = await prisma.wordle_games.findUnique({
      where: { id: gameId },
      include: { word: true },
    });

    if (!game || game.userId !== userId) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    if (game.status !== 'playing') {
      res.status(400).json({ error: 'Game already completed' });
      return;
    }

    const targetWord = game.word.word.toUpperCase();
    const guessWord = guess.toUpperCase();

    if (guessWord.length !== targetWord.length) {
      res.status(400).json({ error: `Guess must be ${targetWord.length} letters` });
      return;
    }

    const result = guessWord.split('').map((letter: string, i: number) => {
      if (letter === targetWord[i]) {
        return { letter, status: 'correct' as const };
      } else if (targetWord.includes(letter)) {
        return { letter, status: 'present' as const };
      } else {
        return { letter, status: 'absent' as const };
      }
    });

    const newGuesses = [...(game.guesses as any[]), { guess: guessWord, result }];
    const isWon = guessWord === targetWord;
    const isLost = !isWon && newGuesses.length >= game.maxAttempts;
    const newStatus = isWon ? 'won' : isLost ? 'lost' : 'playing';
    const xpEarned = isWon ? game.word.xpReward : 0;

    await prisma.$transaction([
      prisma.wordle_games.update({
        where: { id: gameId },
        data: {
          guesses: newGuesses,
          attempts: newGuesses.length,
          status: newStatus,
          xpEarned,
          ...(newStatus !== 'playing' ? { completedAt: new Date() } : {}),
        },
      }),
      ...(isWon
        ? [
            prisma.user.update({
              where: { id: userId },
              data: { xpBalance: { increment: xpEarned } },
            }),
            prisma.xp_transactions.create({
              data: {
                userId,
                amount: xpEarned,
                type: 'wordle_win',
                source: 'tech_wordle',
                sourceId: gameId,
                description: 'Won daily wordle',
              },
            }),
          ]
        : []),
    ]);

    res.status(200).json({
      result,
      status: newStatus,
      xpEarned,
      ...(newStatus !== 'playing' ? { word: targetWord } : {}),
    });
  } catch (error) {
    console.error('Error submitting wordle guess:', error);
    res.status(500).json({ error: 'Failed to submit guess' });
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
  req: AuthenticatedRequest,
  res: Response<any>
): Promise<void> => {
  try {
    const battles = await prisma.quiz_battles.findMany({
      where: { status: 'waiting' },
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        player1: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
      },
    });

    res.status(200).json({ battles });
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
        player1: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
        player2: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
      },
    });

    if (!battle) {
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
      battle,
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
    const { questionId, selectedIndex, timeSpent } = req.body;

    const battle = await prisma.quiz_battles.findUnique({
      where: { id: battleId },
    });

    if (!battle) {
      res.status(404).json({ error: 'Battle not found' });
      return;
    }

    const qId = ensureString(questionId);
    if (!qId) {
      res.status(400).json({ error: 'Question ID is required' });
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
    const { wpm, accuracy, rawWpm, timeSpent, mistakes, charsTyped } = req.body;

    const race = await prisma.typing_races.findUnique({
      where: { id: raceId },
      include: { text: true },
    });

    if (!race || race.userId !== userId) {
      res.status(404).json({ error: 'Race not found' });
      return;
    }

    const xpEarned = Math.floor(wpm * accuracy / 100);

    const updatedRace = await prisma.typing_races.update({
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

    // Update user XP
    await prisma.user.update({
      where: { id: userId },
      data: { xpBalance: { increment: xpEarned } },
    });

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
        text: {
          select: { title: true, category: true, difficulty: true },
        },
      },
    });

    res.status(200).json({ races });
  } catch (error) {
    console.error('Error fetching typing history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
};
