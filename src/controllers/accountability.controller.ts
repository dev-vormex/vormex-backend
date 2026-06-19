import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import { ensureString } from '../utils/request.util';

/**
 * Get current accountability partners
 * GET /api/accountability/partners
 */
export const getPartners = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const pairs = await prisma.accountability_pairs.findMany({
      where: {
        status: 'active',
        OR: [{ user1Id: userId }, { user2Id: userId }],
      },
      include: {
        users_accountability_pairs_user1IdTousers: {
          select: {
            id: true,
            name: true,
            username: true,
            profileImage: true,
            headline: true,
            college: true,
          },
        },
        users_accountability_pairs_user2IdTousers: {
          select: {
            id: true,
            name: true,
            username: true,
            profileImage: true,
            headline: true,
            college: true,
          },
        },
      },
    });

    const partners = pairs.map((p) => {
      const partner = p.user1Id === userId ? p.users_accountability_pairs_user2IdTousers : p.users_accountability_pairs_user1IdTousers;
      return {
        id: p.id,
        partner,
        goal: p.goal,
        sharedStreak: p.sharedStreak,
        bestStreak: p.bestStreak,
        lastCheckIn: p.lastCheckIn?.toISOString() ?? null,
        checkInsCompleted: p.checkInsCompleted,
        startedAt: p.startedAt.toISOString(),
      };
    });

    res.json({ partners });
  } catch (error) {
    console.error('Error fetching accountability partners:', error);
    res.status(500).json({ error: 'Failed to fetch partners' });
  }
};

/**
 * Check in for an accountability pair
 * POST /api/accountability/partners/:pairId/check-in
 */
export const checkIn = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const pairId = ensureString(req.params.pairId);
    const pair = await prisma.accountability_pairs.findFirst({
      where: {
        id: pairId,
        status: 'active',
        OR: [{ user1Id: userId }, { user2Id: userId }],
      },
    });

    if (!pair) {
      res.status(404).json({ error: 'Pair not found' });
      return;
    }

    const now = new Date();
    const lastCheckIn = pair.lastCheckIn ? new Date(pair.lastCheckIn) : null;
    const lastCheckInDate = lastCheckIn ? lastCheckIn.toISOString().split('T')[0] : null;
    const todayStr = now.toISOString().split('T')[0];

    if (lastCheckInDate === todayStr) {
      res.status(400).json({ error: 'Already checked in today' });
      return;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const newStreak = lastCheckInDate === yesterdayStr ? pair.sharedStreak + 1 : 1;
    const newBest = Math.max(pair.bestStreak, newStreak);

    await prisma.accountability_pairs.update({
      where: { id: pairId },
      data: {
        sharedStreak: newStreak,
        bestStreak: newBest,
        lastCheckIn: now,
        checkInsCompleted: { increment: 1 },
      },
    });

    res.json({
      streak: newStreak,
      bestStreak: newBest,
      checkInsCompleted: pair.checkInsCompleted + 1,
    });
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: 'Failed to check in' });
  }
};

/**
 * Get mentorships
 * GET /api/accountability/mentorships
 */
export const getMentorships = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const matches = await prisma.mentorship_matches.findMany({
      where: {
        OR: [{ mentorId: userId }, { menteeId: userId }],
      },
      orderBy: [{ startedAt: 'desc' }],
      include: {
        users_mentorship_matches_mentorIdTousers: {
          select: {
            id: true,
            name: true,
            username: true,
            profileImage: true,
            headline: true,
            college: true,
          },
        },
        users_mentorship_matches_menteeIdTousers: {
          select: {
            id: true,
            name: true,
            username: true,
            profileImage: true,
            headline: true,
            college: true,
          },
        },
      },
    });

    res.json({
      mentorships: matches.map((match) => {
        const isMentor = match.mentorId === userId;
        const otherUser = isMentor
          ? match.users_mentorship_matches_menteeIdTousers
          : match.users_mentorship_matches_mentorIdTousers;

        return {
          id: match.id,
          skill: match.skill,
          status: match.status,
          sessionsCompleted: match.sessionsCompleted,
          rating: match.rating,
          role: isMentor ? 'mentor' : 'mentee',
          startedAt: match.startedAt.toISOString(),
          completedAt: match.completedAt?.toISOString() ?? null,
          partner: otherUser,
        };
      }),
    });
  } catch (error) {
    console.error('Error fetching mentorships:', error);
    res.status(500).json({ error: 'Failed to fetch mentorships' });
  }
};
