import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { notificationService } from '../services/notification.service';
import { pushNotificationService } from '../services/push-notification.service';
import {
  areUsersBlocked,
  assertUsersCanInteract,
  getBlockedUserIds,
  safetyErrorResponse,
} from '../services/trust-safety.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export const followUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }

    if (userId === req.user.userId) {
      res.status(400).json({ error: 'Cannot follow yourself' });
      return;
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await assertUsersCanInteract(req.user.userId, userId, 'follow');

    let follow;
    try {
      follow = await prisma.$transaction(async (tx) => {
        const created = await tx.follows.create({
          data: {
            id: randomUUID(),
            followerId: req.user!.userId,
            followingId: userId,
          },
        });

        await Promise.all([
          tx.userStats.upsert({
            where: { userId: req.user!.userId },
            update: { followingCount: { increment: 1 } },
            create: { userId: req.user!.userId, followingCount: 1 },
          }),
          tx.userStats.upsert({
            where: { userId },
            update: { followersCount: { increment: 1 } },
            create: { userId, followersCount: 1 },
          }),
        ]);

        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(400).json({ error: 'Already following this user' });
        return;
      }
      throw error;
    }

    // Get follower info for notification
    const follower = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { name: true },
    });

    // Send in-app notification (non-blocking)
    notificationService.notifyFollow(
      userId,
      req.user.userId,
      follower?.name || 'Someone'
    ).catch(console.error);

    // Send push notification (non-blocking)
    pushNotificationService.sendToUser(userId, {
      title: 'New Follower',
      body: `${follower?.name || 'Someone'} started following you`,
      data: {
        type: 'follow',
        actorId: req.user.userId,
        screen: 'profile',
      },
    }).catch(console.error);

    res.status(201).json({
      message: 'Successfully followed user',
      follow: {
        id: follow.id,
        followerId: follow.followerId,
        followingId: follow.followingId,
        createdAt: follow.createdAt.toISOString(),
      },
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('followUser error:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
};

export const unfollowUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.follows.deleteMany({
        where: {
          followerId: req.user!.userId,
          followingId: userId,
        },
      });

      if (result.count !== 1) {
        return false;
      }

      await Promise.all([
        tx.userStats.update({
          where: { userId: req.user!.userId },
          data: { followingCount: { decrement: 1 } },
        }),
        tx.userStats.update({
          where: { userId },
          data: { followersCount: { decrement: 1 } },
        }),
      ]);

      return true;
    });

    if (!deleted) {
      res.status(400).json({ error: 'Not following this user' });
      return;
    }

    res.status(200).json({ message: 'Successfully unfollowed user' });
  } catch (error) {
    console.error('unfollowUser error:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
};

export const getFollowStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }
    if (userId !== req.user.userId && await areUsersBlocked(req.user.userId, userId)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }

    const [isFollowing, isFollowedBy] = await Promise.all([
      prisma.follows.findUnique({
        where: {
          followerId_followingId: {
            followerId: req.user.userId,
            followingId: userId,
          },
        },
      }),
      prisma.follows.findUnique({
        where: {
          followerId_followingId: {
            followerId: userId,
            followingId: req.user.userId,
          },
        },
      }),
    ]);

    res.status(200).json({
      isFollowing: !!isFollowing,
      isFollowedBy: !!isFollowedBy,
    });
  } catch (error) {
    console.error('getFollowStatus error:', error);
    res.status(500).json({ error: 'Failed to get follow status' });
  }
};

export const getFollowers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }
    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;
    const viewerId = req.user?.userId ? String(req.user.userId) : null;
    if (viewerId && viewerId !== userId && await areUsersBlocked(viewerId, userId)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }
    const blockedUserIds = viewerId ? await getBlockedUserIds(viewerId) : [];
    const followerWhere: any = {
      followingId: userId,
      ...(blockedUserIds.length > 0 ? { followerId: { notIn: blockedUserIds } } : {}),
    };

    const [followers, total] = await Promise.all([
      prisma.follows.findMany({
        where: followerWhere,
        include: {
          users_follows_followerIdTousers: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
              college: true,
              isOnline: true,
              isVerified: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.follows.count({
        where: followerWhere,
      }),
    ]);

    res.status(200).json({
      followers: followers.map((f) => {
        const fWithFollower = f as typeof f & { users_follows_followerIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null; isOnline: boolean } };
        return {
          id: f.id,
          createdAt: f.createdAt.toISOString(),
          user: fWithFollower.users_follows_followerIdTousers,
        };
      }),
      total,
      page,
      hasMore: skip + followers.length < total,
    });
  } catch (error) {
    console.error('getFollowers error:', error);
    res.status(500).json({ error: 'Failed to get followers' });
  }
};

export const getFollowing = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }
    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;
    const viewerId = req.user?.userId ? String(req.user.userId) : null;
    if (viewerId && viewerId !== userId && await areUsersBlocked(viewerId, userId)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }
    const blockedUserIds = viewerId ? await getBlockedUserIds(viewerId) : [];
    const followingWhere: any = {
      followerId: userId,
      ...(blockedUserIds.length > 0 ? { followingId: { notIn: blockedUserIds } } : {}),
    };

    const [following, total] = await Promise.all([
      prisma.follows.findMany({
        where: followingWhere,
        include: {
          users_follows_followingIdTousers: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
              college: true,
              isOnline: true,
              isVerified: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.follows.count({
        where: followingWhere,
      }),
    ]);

    res.status(200).json({
      following: following.map((f) => {
        const fWithFollowing = f as typeof f & { users_follows_followingIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null; isOnline: boolean } };
        return {
          id: f.id,
          createdAt: f.createdAt.toISOString(),
          user: fWithFollowing.users_follows_followingIdTousers,
        };
      }),
      total,
      page,
      hasMore: skip + following.length < total,
    });
  } catch (error) {
    console.error('getFollowing error:', error);
    res.status(500).json({ error: 'Failed to get following' });
  }
};

export const getMutualInfo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }

    const [myConnections, theirConnections, myFollowing, theirFollowers] = await Promise.all([
      prisma.connections.findMany({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: req.user.userId },
            { addresseeId: req.user.userId },
          ],
        },
        select: { requesterId: true, addresseeId: true },
      }),
      prisma.connections.findMany({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: userId },
            { addresseeId: userId },
          ],
        },
        select: { requesterId: true, addresseeId: true },
      }),
      prisma.follows.findMany({
        where: { followerId: req.user.userId },
        select: { followingId: true },
      }),
      prisma.follows.findMany({
        where: { followingId: userId },
        select: { followerId: true },
      }),
    ]);

    const myConnectionIds = new Set(
      myConnections.map((c) =>
        c.requesterId === req.user!.userId ? c.addresseeId : c.requesterId
      )
    );
    const theirConnectionIds = new Set(
      theirConnections.map((c) =>
        c.requesterId === userId ? c.addresseeId : c.requesterId
      )
    );
    const mutualConnectionIds = [...myConnectionIds].filter((id) => theirConnectionIds.has(id));

    const myFollowingIds = new Set(myFollowing.map((f) => f.followingId));
    const theirFollowerIds = new Set(theirFollowers.map((f) => f.followerId));
    const mutualFollowerIds = [...myFollowingIds].filter((id) => theirFollowerIds.has(id));

    const [mutualConnections, mutualFollowers] = await Promise.all([
      mutualConnectionIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: mutualConnectionIds.slice(0, 10) } },
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
              college: true,
              isOnline: true,
              isVerified: true,
            },
          })
        : [],
      mutualFollowerIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: mutualFollowerIds.slice(0, 10) } },
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              headline: true,
              college: true,
              isOnline: true,
              isVerified: true,
            },
          })
        : [],
    ]);

    res.status(200).json({
      mutualConnections,
      mutualFollowers,
      mutualConnectionsCount: mutualConnectionIds.length,
      mutualFollowersCount: mutualFollowerIds.length,
    });
  } catch (error) {
    console.error('getMutualInfo error:', error);
    res.status(500).json({ error: 'Failed to get mutual info' });
  }
};

export const getFollowCounts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }

    const [followersCount, followingCount] = await Promise.all([
      prisma.follows.count({ where: { followingId: userId } }),
      prisma.follows.count({ where: { followerId: userId } }),
    ]);

    res.status(200).json({
      followersCount,
      followingCount,
    });
  } catch (error) {
    console.error('getFollowCounts error:', error);
    res.status(500).json({ error: 'Failed to get follow counts' });
  }
};
