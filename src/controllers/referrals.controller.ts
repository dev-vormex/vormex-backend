import { Request, Response } from 'express';
import { prisma } from '../config/prisma';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function buildReferralCode(userId: string, username?: string | null): string {
  return `VORMEX-${username?.toUpperCase().slice(0, 6) || 'USER'}-${userId.slice(-4).toUpperCase()}`;
}

function buildReferralLink(baseUrl: string, referralCode: string): string {
  return `${baseUrl}/login?mode=signup&ref=${encodeURIComponent(referralCode)}`;
}

// Get my referral code
export const getMyReferralCode = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    const referralCode = buildReferralCode(userId, user?.username);

    res.json(referralCode);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get referral code' });
  }
};

// Apply referral code
export const applyReferralCode = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { code } = req.body;

    if (!code) {
      res.status(400).json({ error: 'Referral code is required' });
      return;
    }

    res.json({
      success: true,
      message: 'Referral code applied successfully!',
      xpEarned: 100,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to apply referral code' });
  }
};

// Get referral stats
export const getReferralStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    res.json({
      referralCode: buildReferralCode(userId, user?.username),
      totalReferrals: 0,
      completedReferrals: 0,
      activeReferrals: 0,
      pendingReferrals: 0,
      totalXpEarned: 0,
      totalXPEarned: 0,
      milestones: {
        signups: 0,
        profileCompleted: 0,
        firstPosts: 0,
        connections: 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get referral stats' });
  }
};

// Get referrals list
export const getReferralsList = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get referrals list' });
  }
};

// Get referral leaderboard
export const getReferralLeaderboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { limit = 10 } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
};

// Get share links
export const getShareLinks = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    const referralCode = buildReferralCode(userId, user?.username);
    const baseUrl = process.env.FRONTEND_URL || 'https://vormex.in';
    const link = buildReferralLink(baseUrl, referralCode);

    res.json({
      code: referralCode,
      link,
      whatsapp: `https://wa.me/?text=${encodeURIComponent(`Join me on Vormex! ${link}`)}`,
      twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Join me on Vormex! ${link}`)}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get share links' });
  }
};
