import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { prisma, prismaRead } from '../config/prisma';
import { cacheService } from '../services/cache.service';
import {
  assertUsersCanInteract,
  getBlockedUserIds,
  safetyErrorResponse,
} from '../services/trust-safety.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const MENTION_SEARCH_CACHE_TTL_SECONDS = 60;
const MENTION_SEARCH_MAX_LIMIT = 15;
const MENTION_SEARCH_MIN_LENGTH = 2;

const normalizeMentionSearch = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 50);
};

const mentionSearchCacheKey = (query: string, limit: number, userId: string): string =>
  `mentions:search:v2:user:${createHash('sha256').update(userId).digest('hex').slice(0, 16)}:${createHash('sha256').update(query.toLowerCase()).digest('hex').slice(0, 24)}:${limit}`;

const filterBlockedMentionUsers = <T extends { id?: unknown }>(users: T[], blockedUserIds: Set<string>): T[] =>
  users.filter((user) => !user.id || !blockedUserIds.has(String(user.id)));

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

    const currentUserId = req.user.userId;
    const query = normalizeMentionSearch((req.query.q as string) || (req.query.query as string) || '');
    const parsedLimit = parseInt((req.query.limit as string) || '10', 10);
    const limit = Math.min(MENTION_SEARCH_MAX_LIMIT, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 10));

    if (!query || query.length < MENTION_SEARCH_MIN_LENGTH) {
      res.json({ users: [] });
      return;
    }

    const blockedUserIds = await getBlockedUserIds(currentUserId);
    const blockedUserIdSet = new Set(blockedUserIds);
    const cacheKey = mentionSearchCacheKey(query, limit, currentUserId);
    const cached = await cacheService.get<{ users: any[] }>(cacheKey);
    if (cached) {
      res.setHeader('X-Vormex-Cache', 'HIT');
      res.json({ ...cached, users: filterBlockedMentionUsers(cached.users, blockedUserIdSet) });
      return;
    }

    const users = await prismaRead.user.findMany({
      where: {
        id: { notIn: [currentUserId, ...blockedUserIds] },
        isBanned: false,
        OR: [
          { username: { startsWith: query, mode: 'insensitive' } },
          { name: { startsWith: query, mode: 'insensitive' } },
          { username: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
        isVerified: true,
        profileBadgeStyle: true,
      },
      orderBy: [{ lastActiveAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: limit,
    });

    const response = {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        avatar: u.profileImage,
        profileImage: u.profileImage,
        headline: u.headline,
      verified: Boolean(u.isVerified),
      isVerified: Boolean(u.isVerified),
      profileBadgeStyle: u.profileBadgeStyle ?? null,
    })),
    };

    await cacheService.set(cacheKey, response, MENTION_SEARCH_CACHE_TTL_SECONDS, ['people:global']);

    res.setHeader('X-Vormex-Cache', 'MISS');
    res.json(response);
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

    const uniqueUserIds = Array.from(
      new Set(userIds.map((id) => String(id || '').trim()).filter(Boolean))
    ).filter((id) => id !== req.user?.userId);

    await Promise.all(
      uniqueUserIds.map((targetUserId) =>
        assertUsersCanInteract(req.user!.userId, targetUserId, 'mention')
      )
    );

    res.status(201).json({
      message: 'Mentions created (feature pending full implementation)',
      count: uniqueUserIds.length,
      mentions: [],
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
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
