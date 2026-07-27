import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { notificationService } from '../services/notification.service';
import { pushNotificationService } from '../services/push-notification.service';
import {
  FREE_CONNECTION_REQUESTS_PER_DAY,
  getConnectionRequestLimitState,
} from '../services/tier-limits.service';
import { cacheService } from '../services/cache.service';
import {
  applyPremiumVisibilityToUser,
  getPremiumVisibilityByUserIds,
} from '../services/premium-visibility.service';
import { getPremiumPlan } from '../services/premium-access.service';
import {
  assertUsersCanInteract,
  enforceTrustTierLimit,
  safetyErrorResponse,
} from '../services/trust-safety.service';
import { queueNames } from '../infrastructure/queue/queue-names';
import { enqueueOutboxEvent } from '../outbox/service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const TOP_NETWORKERS_CACHE_TAG = 'engagement:leaderboard';

type CanonicalRelationshipStatus = 'none' | 'pending_sent' | 'pending_received' | 'connected';

const canonicalRelationship = (
  status: CanonicalRelationshipStatus,
  connectionId: string | null
) => ({ status, connectionId });

const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

const discoveryCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueCacheTags(
    [
      TOP_NETWORKERS_CACHE_TAG,
      ...userIds.flatMap((userId) =>
        userId
          ? [
              `people:user:${userId}`,
              `people:connections:${userId}`,
              `matching:user:${userId}`,
              `user:${userId}`,
            ]
          : []
      ),
    ]
  );

const invalidateDiscoveryCaches = async (
  ...userIds: Array<string | null | undefined>
): Promise<void> => {
  const tags = discoveryCacheTags(...userIds);
  if (tags.length === 0) return;

  try {
    await cacheService.invalidateTags(...tags);
  } catch (error) {
    console.error('connection discovery cache invalidation failed:', error);
  }
};

export const sendConnectionRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { receiverId, message } = req.body;

    if (!receiverId) {
      res.status(400).json({ error: 'Receiver ID is required' });
      return;
    }

    if (receiverId === req.user.userId) {
      res.status(400).json({ error: 'Cannot send connection request to yourself' });
      return;
    }

    const receiver = await prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
    });

    if (!receiver) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await assertUsersCanInteract(req.user.userId, receiverId, 'connection request');

    const existingConnection = await prisma.connections.findFirst({
      where: {
        OR: [
          { requesterId: req.user.userId, addresseeId: receiverId },
          { requesterId: receiverId, addresseeId: req.user.userId },
        ],
      },
    });

    if (existingConnection) {
      if (existingConnection.status === 'accepted') {
        res.status(200).json({
          message: 'Already connected',
          connection: {
            id: existingConnection.id,
            status: 'ACCEPTED',
            message: null,
            createdAt: existingConnection.createdAt.toISOString(),
            user: receiver,
          },
          relationship: canonicalRelationship('connected', existingConnection.id),
        });
        return;
      }
      if (existingConnection.status === 'pending') {
        const relationshipStatus = existingConnection.requesterId === req.user.userId
          ? 'pending_sent'
          : 'pending_received';
        res.status(200).json({
          message: 'Connection request already pending',
          connection: {
            id: existingConnection.id,
            status: 'PENDING',
            message: null,
            createdAt: existingConnection.createdAt.toISOString(),
            user: receiver,
          },
          relationship: canonicalRelationship(relationshipStatus, existingConnection.id),
        });
        return;
      }
    }

    const limitState = await getConnectionRequestLimitState(req.user.userId);
    if (!limitState.allowed) {
      res.status(403).json({
        error: `Free accounts can send up to ${FREE_CONNECTION_REQUESTS_PER_DAY} connection requests per day. Upgrade to Premium for unlimited requests.`,
        code: 'connection_request_limit_reached',
        limit: limitState.limit,
        used: limitState.used,
        remaining: limitState.remaining,
      });
      return;
    }

    await enforceTrustTierLimit(req.user.userId, 'connection_request');

    const connection = existingConnection
      ? await prisma.connections.update({
          where: { id: existingConnection.id },
          data: {
            requesterId: req.user.userId,
            addresseeId: receiverId,
            status: 'pending',
            updatedAt: new Date(),
          },
        })
      : await prisma.connections.create({
          data: {
            id: randomUUID(),
            requesterId: req.user.userId,
            addresseeId: receiverId,
            status: 'pending',
            updatedAt: new Date(),
          },
        });

    // Get requester info for notification
    const requester = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { name: true },
    });

    // Send in-app notification (non-blocking)
    notificationService.notifyConnectionRequest(
      receiverId,
      req.user.userId,
      requester?.name || 'Someone'
    ).catch(console.error);

    // Send push notification (non-blocking)
    pushNotificationService.pushConnectionRequest(
      receiverId,
      requester?.name || 'Someone',
      connection.id
    ).catch(console.error);

    await invalidateDiscoveryCaches(req.user.userId, receiverId);

    res.status(201).json({
      message: 'Connection request sent',
      connection: {
        id: connection.id,
        status: 'PENDING',
        message: message || null,
        createdAt: connection.createdAt.toISOString(),
        user: receiver,
      },
      relationship: canonicalRelationship('pending_sent', connection.id),
    });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('sendConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to send connection request' });
  }
};

export const acceptConnectionRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const connectionId = ensureString(req.params.connectionId);
    if (!connectionId) {
      res.status(400).json({ error: 'Connection ID required' });
      return;
    }

    const connection = await prisma.connections.findUnique({
      where: { id: connectionId },
      include: {
        users_connections_requesterIdTousers: {
          select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
        },
        users_connections_addresseeIdTousers: {
          select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
        },
      },
    });

    if (!connection) {
      res.status(404).json({ error: 'Connection request not found' });
      return;
    }

    if (connection.addresseeId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to accept this request' });
      return;
    }

    if (connection.status === 'accepted') {
      res.status(200).json({
        message: 'Connection request already accepted',
        connection: {
          id: connection.id,
          status: 'ACCEPTED',
          message: null,
          createdAt: connection.createdAt.toISOString(),
          user: connection.users_connections_requesterIdTousers,
        },
        relationship: canonicalRelationship('connected', connection.id),
      });
      return;
    }

    if (connection.status !== 'pending') {
      res.status(400).json({ error: 'Connection request is no longer pending' });
      return;
    }

    const accepted = await prisma.$transaction(async (tx) => {
      const acceptResult = await tx.connections.updateMany({
        where: { id: connectionId, addresseeId: req.user!.userId, status: 'pending' },
        data: { status: 'accepted' },
      });

      if (acceptResult.count !== 1) {
        return null;
      }

      // Persist one durable job in the same minimal transaction as the accept.
      await enqueueOutboxEvent(tx, {
        aggregateType: 'connection',
        aggregateId: connectionId,
        eventType: 'connection.accepted.side_effects',
        queueName: queueNames.connectionSideEffects,
        idempotencyKey: `connection:${connectionId}:accepted:side-effects`,
        payload: {
          connectionId,
          requesterId: connection.requesterId,
          addresseeId: connection.addresseeId,
          requester: connection.users_connections_requesterIdTousers,
          addressee: connection.users_connections_addresseeIdTousers,
        },
      });

      return true;
    });

    if (!accepted) {
      const latest = await prisma.connections.findUnique({ where: { id: connectionId } });
      if (latest?.status === 'accepted') {
        res.status(200).json({
          message: 'Connection request already accepted',
          connection: {
            id: connection.id,
            status: 'ACCEPTED',
            message: null,
            createdAt: connection.createdAt.toISOString(),
            user: connection.users_connections_requesterIdTousers,
          },
          relationship: canonicalRelationship('connected', connection.id),
        });
        return;
      }
      res.status(409).json({ error: 'Connection request changed; refresh and try again' });
      return;
    }

    await invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);

    res.status(200).json({
      message: 'Connection request accepted',
      connection: {
        id: connection.id,
        status: 'ACCEPTED',
        message: null,
        createdAt: connection.createdAt.toISOString(),
        user: connection.users_connections_requesterIdTousers,
      },
      relationship: canonicalRelationship('connected', connection.id),
    });
  } catch (error) {
    console.error('acceptConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to accept connection request' });
  }
};

export const rejectConnectionRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const connectionId = ensureString(req.params.connectionId);
    if (!connectionId) {
      res.status(400).json({ error: 'Connection ID required' });
      return;
    }

    const connection = await prisma.connections.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      res.status(404).json({ error: 'Connection request not found' });
      return;
    }

    if (connection.addresseeId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to reject this request' });
      return;
    }

    await prisma.$transaction([
      prisma.connections.update({
        where: { id: connectionId },
        data: { status: 'rejected' },
      }),
      prisma.notifications.deleteMany({
        where: {
          userId: connection.addresseeId,
          type: 'connection_request',
          actorId: connection.requesterId,
        },
      }),
    ]);

    await invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);

    res.status(200).json({
      message: 'Connection request rejected',
      relationship: canonicalRelationship('none', null),
    });
  } catch (error) {
    console.error('rejectConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to reject connection request' });
  }
};

export const cancelConnectionRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const connectionId = ensureString(req.params.connectionId);
    if (!connectionId) {
      res.status(400).json({ error: 'Connection ID required' });
      return;
    }

    const connection = await prisma.connections.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      res.status(404).json({ error: 'Connection request not found' });
      return;
    }

    if (connection.requesterId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to cancel this request' });
      return;
    }

    if (connection.status !== 'pending') {
      res.status(400).json({ error: 'Can only cancel pending requests' });
      return;
    }

    await prisma.$transaction([
      prisma.notifications.deleteMany({
        where: {
          userId: connection.addresseeId,
          type: 'connection_request',
          actorId: connection.requesterId,
        },
      }),
      prisma.connections.delete({
        where: { id: connectionId },
      }),
    ]);

    await invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);

    res.status(200).json({
      message: 'Connection request cancelled',
      relationship: canonicalRelationship('none', null),
    });
  } catch (error) {
    console.error('cancelConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to cancel connection request' });
  }
};

export const removeConnection = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const connectionId = ensureString(req.params.connectionId);
    if (!connectionId) {
      res.status(400).json({ error: 'Connection ID required' });
      return;
    }

    const connection = await prisma.connections.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }

    if (connection.requesterId !== req.user.userId && connection.addresseeId !== req.user.userId) {
      res.status(403).json({ error: 'Not authorized to remove this connection' });
      return;
    }

    if (connection.status !== 'accepted') {
      res.status(400).json({ error: 'Can only remove accepted connections' });
      return;
    }

    await prisma.connections.delete({
      where: { id: connectionId },
    });

    await prisma.userStats.updateMany({
      where: { userId: { in: [connection.requesterId, connection.addresseeId] } },
      data: { connectionsCount: { decrement: 1 } },
    });

    await invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);

    res.status(200).json({
      message: 'Connection removed',
      relationship: canonicalRelationship('none', null),
    });
  } catch (error) {
    console.error('removeConnection error:', error);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
};

export const getConnections = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: req.user.userId },
            { addresseeId: req.user.userId },
          ],
        },
        include: {
          users_connections_requesterIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
          },
          users_connections_addresseeIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.connections.count({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: req.user.userId },
            { addresseeId: req.user.userId },
          ],
        },
      }),
    ]);

    const formatted = connections.map((conn) => {
      const connWithIncludes = conn as typeof conn & { users_connections_requesterIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null }; users_connections_addresseeIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      const user = conn.requesterId === req.user!.userId ? connWithIncludes.users_connections_addresseeIdTousers : connWithIncludes.users_connections_requesterIdTousers;
      return {
        id: conn.id,
        status: 'ACCEPTED',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        user,
      };
    });

    res.status(200).json({
      connections: formatted,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + connections.length < total,
    });
  } catch (error) {
    console.error('getConnections error:', error);
    res.status(500).json({ error: 'Failed to get connections' });
  }
};

export const getUserConnections = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = ensureString(req.params.userId);
    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }
    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: userId },
            { addresseeId: userId },
          ],
        },
        include: {
          users_connections_requesterIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
          },
          users_connections_addresseeIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.connections.count({
        where: {
          status: 'accepted',
          OR: [
            { requesterId: userId },
            { addresseeId: userId },
          ],
        },
      }),
    ]);

    const formatted = connections.map((conn) => {
      const connWithIncludes = conn as typeof conn & { users_connections_requesterIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null }; users_connections_addresseeIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      const user = conn.requesterId === userId ? connWithIncludes.users_connections_addresseeIdTousers : connWithIncludes.users_connections_requesterIdTousers;
      return {
        id: conn.id,
        status: 'ACCEPTED',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        user,
      };
    });

    res.status(200).json({
      connections: formatted,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + connections.length < total,
    });
  } catch (error) {
    console.error('getUserConnections error:', error);
    res.status(500).json({ error: 'Failed to get user connections' });
  }
};

export const getPendingRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;
    const now = new Date();

    const [orderedRows, total] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c."id"
        FROM "connections" c
        LEFT JOIN "subscriptions" s
          ON s."userId" = c."requesterId"
          AND s."plan" = ${getPremiumPlan()}
          AND LOWER(s."status") IN ('active', 'captured', 'authorized')
          AND (s."cancelledAt" IS NULL OR s."cancelledAt" > ${now})
          AND (s."currentPeriodEnd" IS NULL OR s."currentPeriodEnd" > ${now})
        LEFT JOIN LATERAL (
          SELECT MAX(b."priority") AS "boostPriority"
          FROM "profile_boosts" b
          WHERE b."userId" = c."requesterId"
            AND b."status" = 'active'
            AND b."startsAt" <= ${now}
            AND b."endsAt" > ${now}
        ) boost ON TRUE
        WHERE c."addresseeId" = ${req.user.userId}
          AND c."status" = 'pending'
        ORDER BY
          COALESCE(boost."boostPriority", 0) DESC,
          CASE WHEN s."id" IS NULL THEN 0 ELSE 1 END DESC,
          c."createdAt" DESC
        OFFSET ${skip}
        LIMIT ${limit}
      `),
      prisma.connections.count({
        where: {
          addresseeId: req.user.userId,
          status: 'pending',
        },
      }),
    ]);

    const orderedIds = orderedRows.map((row) => row.id).filter(Boolean);
    const unorderedConnections = orderedIds.length > 0
      ? await prisma.connections.findMany({
          where: { id: { in: orderedIds } },
          include: {
            users_connections_requesterIdTousers: {
              select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
            },
          },
        })
      : [];
    const connectionsById = new Map(unorderedConnections.map((connection) => [connection.id, connection]));
    const connections = orderedIds
      .map((id) => connectionsById.get(id))
      .filter((connection): connection is NonNullable<typeof connection> => Boolean(connection));
    const visibilityByUser = await getPremiumVisibilityByUserIds(
      connections.map((connection) => connection.requesterId)
    );
    const formatted = connections.map((conn) => {
      const connWithRequester = conn as typeof conn & { users_connections_requesterIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      const user = applyPremiumVisibilityToUser(
        connWithRequester.users_connections_requesterIdTousers,
        visibilityByUser
      );
      return {
        id: conn.id,
        status: 'PENDING',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        priority: visibilityByUser.get(conn.requesterId)?.requestQueuePriority || 0,
        priorityLabel: user.profileBoostActive
          ? 'Boosted'
          : user.isPremium
            ? 'Premium'
            : null,
        user,
      };
    });

    res.status(200).json({
      connections: formatted,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + connections.length < total,
    });
  } catch (error) {
    console.error('getPendingRequests error:', error);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
};

export const getSentRequests = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: {
          requesterId: req.user.userId,
          status: 'pending',
        },
        include: {
          users_connections_addresseeIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true, isVerified: true, profileBadgeStyle: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.connections.count({
        where: {
          requesterId: req.user.userId,
          status: 'pending',
        },
      }),
    ]);

    const formatted = connections.map((conn) => {
      const connWithAddressee = conn as typeof conn & { users_connections_addresseeIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      return {
        id: conn.id,
        status: 'PENDING',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        user: connWithAddressee.users_connections_addresseeIdTousers,
      };
    });

    res.status(200).json({
      connections: formatted,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + connections.length < total,
    });
  } catch (error) {
    console.error('getSentRequests error:', error);
    res.status(500).json({ error: 'Failed to get sent requests' });
  }
};

export const getConnectionStatus = async (req: AuthRequest, res: Response): Promise<void> => {
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
      res.status(200).json({ status: 'none' });
      return;
    }

    const connection = await prisma.connections.findFirst({
      where: {
        OR: [
          { requesterId: req.user.userId, addresseeId: userId },
          { requesterId: userId, addresseeId: req.user.userId },
        ],
      },
    });

    if (!connection) {
      res.status(200).json({ status: 'none' });
      return;
    }

    let status: string;
    let direction: string | undefined;

    if (connection.status === 'accepted') {
      status = 'connected';
    } else if (connection.status === 'pending') {
      if (connection.requesterId === req.user.userId) {
        status = 'pending_sent';
        direction = 'sent';
      } else {
        status = 'pending_received';
        direction = 'received';
      }
    } else if (connection.status === 'blocked') {
      status = 'blocked';
    } else {
      status = 'none';
    }

    res.status(200).json({
      status,
      connectionId: connection.id,
      direction,
    });
  } catch (error) {
    console.error('getConnectionStatus error:', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
};
