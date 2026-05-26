import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { notificationService } from '../services/notification.service';
import { pushNotificationService } from '../services/push-notification.service';

interface AuthRequest extends Request {
  user?: { userId: string };
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

    const existingFollow = await prisma.follows.findUnique({
      where: {
        followerId_followingId: {
          followerId: req.user.userId,
          followingId: userId,
        },
      },
    });

    if (existingFollow) {
      res.status(400).json({ error: 'Already following this user' });
      return;
    }

    const follow = await prisma.follows.create({
      data: {
        id: randomUUID(),
        followerId: req.user.userId,
        followingId: userId,
      },
    });

    await Promise.all([
      prisma.userStats.upsert({
        where: { userId: req.user.userId },
        update: { followingCount: { increment: 1 } },
        create: { userId: req.user.userId, followingCount: 1 },
      }),
      prisma.userStats.upsert({
        where: { userId },
        update: { followersCount: { increment: 1 } },
        create: { userId, followersCount: 1 },
      }),
    ]);

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

    const existingFollow = await prisma.follows.findUnique({
      where: {
        followerId_followingId: {
          followerId: req.user.userId,
          followingId: userId,
        },
      },
    });

    if (!existingFollow) {
      res.status(400).json({ error: 'Not following this user' });
      return;
    }

    await prisma.follows.delete({
      where: {
        followerId_followingId: {
          followerId: req.user.userId,
          followingId: userId,
        },
      },
    });

    await Promise.all([
      prisma.userStats.update({
        where: { userId: req.user.userId },
        data: { followingCount: { decrement: 1 } },
      }).catch(() => {}),
      prisma.userStats.update({
        where: { userId },
        data: { followersCount: { decrement: 1 } },
      }).catch(() => {}),
    ]);

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

    const [followers, total] = await Promise.all([
      prisma.follows.findMany({
        where: { followingId: userId },
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
        where: { followingId: userId },
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

    const [following, total] = await Promise.all([
      prisma.follows.findMany({
        where: { followerId: userId },
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
        where: { followerId: userId },
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
