import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { AuthRequest, canonicalRelationship, invalidateDiscoveryCaches, withdrawSentRequest } from "./support.controller";

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

    res.status(200).json({
      message: 'Connection request rejected',
      relationship: canonicalRelationship('none', null),
    });

    // Evict after responding; see sendConnectionRequest for the reasoning.
    void invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);
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

    await withdrawSentRequest(req.user.userId, connection, res);
  } catch (error) {
    console.error('cancelConnectionRequest error:', error);
    res.status(500).json({ error: 'Failed to cancel connection request' });
  }
};

/**
 * Cancel by recipient rather than by connection id.
 *
 * Surfaces know who they are looking at long before they know which row holds
 * the request — a profile opened from a cached snapshot paints "Pending" from a
 * payload whose connection id is missing or stale. Without this the Cancel
 * button had nothing to send and silently did nothing at all.
 */
export const cancelSentRequestToUser = async (req: AuthRequest, res: Response): Promise<void> => {
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
      res.status(400).json({ error: 'Cannot cancel a connection request to yourself' });
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

    await withdrawSentRequest(req.user.userId, connection, res);
  } catch (error) {
    console.error('cancelSentRequestToUser error:', error);
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

    res.status(200).json({
      message: 'Connection removed',
      relationship: canonicalRelationship('none', null),
    });

    // Evict after responding; see sendConnectionRequest for the reasoning.
    void invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);
  } catch (error) {
    console.error('removeConnection error:', error);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
};
