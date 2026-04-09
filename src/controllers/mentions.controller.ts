import { Request, Response } from 'express';
import { prisma } from '../config/prisma';

interface AuthRequest extends Request {
  user?: { userId: string };
}

/**
 * Search users for @mention autocomplete
 * GET /mentions/search?q=query&limit=10
 */
export const searchMentions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const query = (req.query.q as string) || (req.query.query as string) || '';
    const limit = Math.min(20, Math.max(1, parseInt((req.query.limit as string) || '10', 10)));

    if (!query || query.trim().length < 2) {
      res.json({ users: [] });
      return;
    }

    const search = query.trim().toLowerCase();
    const users = await prisma.user.findMany({
      where: {
        isBanned: false,
        OR: [
          { username: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
      },
      take: limit,
    });

    res.json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        avatar: u.profileImage,
        profileImage: u.profileImage,
        headline: u.headline,
      })),
    });
  } catch (error) {
    console.error('searchMentions error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
};

/**
 * Create mentions for a post
 * POST /mentions
 * Body: { postId: string, userIds: string[] }
 * 
 * NOTE: Mention model not yet in schema - returning placeholder response
 */
export const createMentions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { postId, userIds } = req.body;

    if (!postId || !userIds || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(400).json({ error: 'postId and userIds array are required' });
      return;
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    if (post.authorId !== req.user.userId) {
      res.status(403).json({ error: 'You can only add mentions to your own posts' });
      return;
    }

    res.status(201).json({
      message: 'Mentions created (feature pending full implementation)',
      count: userIds.length,
      mentions: [],
    });
  } catch (error) {
    console.error('createMentions error:', error);
    res.status(500).json({ error: 'Failed to create mentions' });
  }
};

/**
 * Get pending mentions for the current user (notifications)
 * GET /mentions/pending
 * 
 * NOTE: Mention model not yet in schema - returning empty list
 */
export const getPendingMentions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({
      mentions: [],
      nextCursor: null,
      hasMore: false,
    });
  } catch (error) {
    console.error('getPendingMentions error:', error);
    res.status(500).json({ error: 'Failed to fetch pending mentions' });
  }
};

/**
 * Get all mentions for the current user
 * GET /mentions
 * 
 * NOTE: Mention model not yet in schema - returning empty list
 */
export const getMyMentions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({
      mentions: [],
      nextCursor: null,
      hasMore: false,
    });
  } catch (error) {
    console.error('getMyMentions error:', error);
    res.status(500).json({ error: 'Failed to fetch mentions' });
  }
};

/**
 * Accept or reject a mention
 * POST /mentions/:mentionId/respond
 * Body: { action: 'accept' | 'reject', showOnProfile?: boolean }
 * 
 * NOTE: Mention model not yet in schema
 */
export const respondToMention = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { action } = req.body;

    if (!action || !['accept', 'reject'].includes(action)) {
      res.status(400).json({ error: 'action must be "accept" or "reject"' });
      return;
    }

    res.status(404).json({ error: 'Mention not found (feature pending full implementation)' });
  } catch (error) {
    console.error('respondToMention error:', error);
    res.status(500).json({ error: 'Failed to respond to mention' });
  }
};

/**
 * Toggle show on profile for an accepted mention
 * PATCH /mentions/:mentionId/profile
 * Body: { showOnProfile: boolean }
 * 
 * NOTE: Mention model not yet in schema
 */
export const toggleShowOnProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { showOnProfile } = req.body;

    if (typeof showOnProfile !== 'boolean') {
      res.status(400).json({ error: 'showOnProfile must be a boolean' });
      return;
    }

    res.status(404).json({ error: 'Mention not found (feature pending full implementation)' });
  } catch (error) {
    console.error('toggleShowOnProfile error:', error);
    res.status(500).json({ error: 'Failed to update profile visibility' });
  }
};

/**
 * Get posts shown on a user's profile (accepted mentions with showOnProfile=true)
 * GET /mentions/profile/:userId
 * 
 * NOTE: Mention model not yet in schema - returning empty list
 */
export const getProfileMentions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      posts: [],
      nextCursor: null,
      hasMore: false,
    });
  } catch (error) {
    console.error('getProfileMentions error:', error);
    res.status(500).json({ error: 'Failed to fetch profile mentions' });
  }
};

/**
 * Get mention count for notification badge
 * GET /mentions/count
 * 
 * NOTE: Mention model not yet in schema - returning 0
 */
export const getMentionCount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({ count: 0 });
  } catch (error) {
    console.error('getMentionCount error:', error);
    res.status(500).json({ error: 'Failed to get mention count' });
  }
};
