import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { awardUserProgress } from "../../../engagement/services/progress.service";

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
      include: { wordle_words: true },
    });

    if (!game || game.userId !== userId) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    if (game.status !== 'playing') {
      res.status(400).json({ error: 'Game already completed' });
      return;
    }

    const targetWord = game.wordle_words.word.toUpperCase();
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
    const xpEarned = isWon ? game.wordle_words.xpReward : 0;

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
    ]);

    if (isWon && xpEarned > 0) {
      await awardUserProgress({
        userId,
        xpAmount: xpEarned,
        coinAmount: xpEarned,
        type: 'wordle_win',
        source: 'tech_wordle',
        sourceId: gameId,
        description: 'Won daily wordle',
        countsForStreak: true,
        idempotencyKey: `${userId}:tech_wordle:${gameId}`,
      });
    }

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
