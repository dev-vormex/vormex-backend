import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { recordActivity } from '../services/activity.service';
import { updateEngagementStreak } from './engagement.controller';
import { getIO } from '../sockets';
import { notificationService } from '../services/notification.service';
import { pushNotificationService } from '../services/push-notification.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

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
      select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
    });

    if (!receiver) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

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
        res.status(400).json({ error: 'Already connected' });
        return;
      }
      if (existingConnection.status === 'pending') {
        res.status(400).json({ error: 'Connection request already pending' });
        return;
      }
    }

    const connection = await prisma.connections.create({
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

    res.status(201).json({
      message: 'Connection request sent',
      connection: {
        id: connection.id,
        status: 'PENDING',
        message: message || null,
        createdAt: connection.createdAt.toISOString(),
        user: receiver,
      },
    });
  } catch (error) {
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
          select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
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

    if (connection.status !== 'pending') {
      res.status(400).json({ error: 'Connection request is no longer pending' });
      return;
    }

    const updated = await prisma.connections.update({
      where: { id: connectionId },
      data: { status: 'accepted' },
    });

    await prisma.userStats.updateMany({
      where: { userId: { in: [connection.requesterId, connection.addresseeId] } },
      data: { connectionsCount: { increment: 1 } },
    });

    // Record activity for both users (non-blocking)
    recordActivity(req.user.userId, 'connection', 1, { sourceId: connectionId }).catch(console.error);
    recordActivity(connection.requesterId, 'connection', 1, { sourceId: connectionId }).catch(console.error);

    // Update engagement streaks for both users (non-blocking)
    updateEngagementStreak(req.user.userId, 'connection').catch(console.error);
    updateEngagementStreak(connection.requesterId, 'connection').catch(console.error);

    // Emit Socket.IO events for celebration
    const io = getIO();
    if (io) {
      // Notify both users about the new connection
      io.to(`user:${req.user.userId}`).emit('connection:accepted', {
        connectionId: updated.id,
        otherUser: connection.users_connections_requesterIdTousers,
      });
      
      // Get addressee info for the requester's celebration
      const addressee = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
      });
      
      io.to(`user:${connection.requesterId}`).emit('connection:accepted', {
        connectionId: updated.id,
        otherUser: addressee,
      });

      // Send in-app notification to requester (non-blocking)
      notificationService.notifyConnectionAccepted(
        connection.requesterId,
        req.user.userId,
        addressee?.name || 'Someone'
      ).catch(console.error);

      // Send push notification to requester (non-blocking)
      pushNotificationService.pushConnectionAccepted(
        connection.requesterId,
        addressee?.name || 'Someone',
        updated.id,
        req.user.userId
      ).catch(console.error);
    }

    res.status(200).json({
      message: 'Connection request accepted',
      connection: {
        id: updated.id,
        status: 'ACCEPTED',
        message: null,
        createdAt: updated.createdAt.toISOString(),
        user: connection.users_connections_requesterIdTousers,
      },
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

    res.status(200).json({ message: 'Connection request rejected' });
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

    res.status(200).json({ message: 'Connection request cancelled' });
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

    res.status(200).json({ message: 'Connection removed' });
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
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
          },
          users_connections_addresseeIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
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
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
          },
          users_connections_addresseeIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
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

    const [connections, total] = await Promise.all([
      prisma.connections.findMany({
        where: {
          addresseeId: req.user.userId,
          status: 'pending',
        },
        include: {
          users_connections_requesterIdTousers: {
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.connections.count({
        where: {
          addresseeId: req.user.userId,
          status: 'pending',
        },
      }),
    ]);

    const formatted = connections.map((conn) => {
      const connWithRequester = conn as typeof conn & { users_connections_requesterIdTousers: { id: string; username: string; name: string | null; profileImage: string | null; headline: string | null; college: string | null } };
      return {
        id: conn.id,
        status: 'PENDING',
        message: null,
        createdAt: conn.createdAt.toISOString(),
        user: connWithRequester.users_connections_requesterIdTousers,
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
            select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true },
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
