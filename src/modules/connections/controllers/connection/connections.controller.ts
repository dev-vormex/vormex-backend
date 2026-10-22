import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { getBlockedUserIds, areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { AuthRequest } from "./support.controller";

export const getConnections = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(ensureString(req.query.page) || '1') || 1;
    const limit = parseInt(ensureString(req.query.limit) || '20') || 20;
    const skip = (page - 1) * limit;
    const blockedUserIds = await getBlockedUserIds(req.user.userId);
    const relationshipWhere: any = {
      status: 'accepted',
      AND: [
        { OR: [{ requesterId: req.user.userId }, { addresseeId: req.user.userId }] },
        ...(blockedUserIds.length > 0
          ? [{ requesterId: { notIn: blockedUserIds }, addresseeId: { notIn: blockedUserIds } }]
          : []),
      ],
    };

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: relationshipWhere,
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
        where: relationshipWhere,
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
    const viewerId = req.user?.userId ? String(req.user.userId) : null;
    if (viewerId && viewerId !== userId && await areUsersBlocked(viewerId, userId)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false });
      return;
    }
    const blockedUserIds = viewerId ? await getBlockedUserIds(viewerId) : [];
    const relationshipWhere: any = {
      status: 'accepted',
      AND: [
        { OR: [{ requesterId: userId }, { addresseeId: userId }] },
        ...(blockedUserIds.length > 0
          ? [{ requesterId: { notIn: blockedUserIds }, addresseeId: { notIn: blockedUserIds } }]
          : []),
      ],
    };

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: relationshipWhere,
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
        where: relationshipWhere,
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
