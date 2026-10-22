import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { AuthRequest } from "./support.controller";

export const votePoll = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { optionId } = req.body;

    if (optionId === undefined) {
      res.status(400).json({ error: 'Option ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        pollQuestion: true,
        pollOptions: true,
        pollEndsAt: true,
      },
    });

    if (!reel || !(await canViewReel(reel, userId)) || !reel.pollQuestion) {
      res.status(404).json({ error: 'Poll not found' });
      return;
    }

    if (reel.pollEndsAt && new Date(reel.pollEndsAt) < new Date()) {
      res.status(400).json({ error: 'Poll has ended' });
      return;
    }

    const existingVote = await prisma.reel_poll_votes.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    if (existingVote) {
      res.status(400).json({ error: 'You have already voted' });
      return;
    }

    await prisma.reel_poll_votes.create({
      data: { reelId, userId, optionId },
    });

    const pollOptions = (reel.pollOptions as any[]) || [];
    const updatedOptions = pollOptions.map((opt: any) => ({
      ...opt,
      votes: opt.id === optionId ? (opt.votes || 0) + 1 : opt.votes || 0,
    }));

    await prisma.reels.update({
      where: { id: reelId },
      data: { pollOptions: updatedOptions },
    });

    res.json({ success: true, pollOptions: updatedOptions, userVotedOption: optionId });
  } catch (error) {
    console.error('votePoll error:', error);
    res.status(500).json({ error: 'Failed to vote on poll' });
  }
};

export const answerQuiz = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const { optionId } = req.body;

    if (optionId === undefined) {
      res.status(400).json({ error: 'Option ID is required' });
      return;
    }

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        quizQuestion: true,
        quizCorrectIndex: true,
      },
    });

    if (!reel || !(await canViewReel(reel, userId)) || !reel.quizQuestion) {
      res.status(404).json({ error: 'Quiz not found' });
      return;
    }

    const existingAnswer = await prisma.reel_quiz_answers.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    if (existingAnswer) {
      res.status(400).json({ error: 'You have already answered' });
      return;
    }

    const isCorrect = optionId === reel.quizCorrectIndex;

    await prisma.reel_quiz_answers.create({
      data: { reelId, userId, optionId, isCorrect },
    });

    res.json({ correct: isCorrect, correctAnswer: reel.quizCorrectIndex });
  } catch (error) {
    console.error('answerQuiz error:', error);
    res.status(500).json({ error: 'Failed to answer quiz' });
  }
};
