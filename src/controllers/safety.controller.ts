import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import {
  createUserBlockWithDeviceScope,
  invalidateBlockedUserIdsCache,
  invalidateMessageInteractionCache,
  publicTrustFields,
  recordSafetyEvent,
} from '../services/trust-safety.service';
import { getIO } from '../sockets';

const emitSafetyStateChanged = (userIds: string[]): void => {
  const io = getIO();
  if (!io) return;
  const payload = {
    reason: 'interaction_policy_changed',
    occurredAt: new Date().toISOString(),
  };
  Array.from(new Set(userIds.filter(Boolean))).forEach((userId) => {
    io.to(`user:${userId}`).emit('safety:state_changed', payload);
  });
};

const blockedUserSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isVerified: true,
  identityTrustLevel: true,
  profileBadgeStyle: true,
} as const;

const mapBlockedUser = (user: any) => ({
  id: user.id,
  username: user.username,
  name: user.name,
  profileImage: user.profileImage,
  isVerified: user.isVerified,
  profileBadgeStyle: user.profileBadgeStyle,
  ...publicTrustFields(user.identityTrustLevel),
});

export const getBlocks = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const blocks = await prisma.user_blocks.findMany({
      where: { blockerId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        blocked: { select: blockedUserSelect },
      },
    });

    res.json({
      blocks: blocks.map((block) => ({
        id: block.id,
        blockedUserId: block.blockedId,
        createdAt: block.createdAt.toISOString(),
        user: mapBlockedUser(block.blocked),
      })),
    });
  } catch (error) {
    console.error('getBlocks error:', error);
    res.status(500).json({ error: 'Failed to load blocked users' });
  }
};

export const blockUser = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const blockedId = String(req.params.userId || '').trim();
    if (!blockedId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }
    if (blockedId === userId) {
      res.status(400).json({ error: 'You cannot block yourself' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: blockedId },
      select: blockedUserSelect,
    });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
    const effects = await createUserBlockWithDeviceScope({
      blockerId: userId,
      blockedId,
      reason,
    });
    const { block, deviceScopeCount } = effects;

    await recordSafetyEvent({
      actorId: userId,
      targetUserId: blockedId,
      eventType: 'USER_BLOCKED',
      entityType: 'user_block',
      entityId: block.id,
      reason,
      metadata: {
        deviceScopeCount,
        removedConnectionCount: effects.removedConnectionCount,
        removedFollowCount: effects.removedFollowCount,
        removedNotificationCount: effects.removedNotificationCount,
      },
    });

    emitSafetyStateChanged([userId, ...effects.affectedUserIds]);

    res.status(201).json({
      message: 'User blocked',
      block: {
        id: block.id,
        blockedUserId: block.blockedId,
        createdAt: block.createdAt.toISOString(),
        user: mapBlockedUser(target),
      },
      effects: {
        affectedConversationIds: effects.affectedConversationIds,
        connectionRemoved: effects.connectionRemoved,
        removedConnectionCount: effects.removedConnectionCount,
        removedFollowCount: effects.removedFollowCount,
        removedNotificationCount: effects.removedNotificationCount,
      },
    });
  } catch (error) {
    console.error('blockUser error:', error);
    const code = (error as { code?: string } | null)?.code;
    if (code === 'P2028') {
      res.status(503).json({
        error: 'Blocking took too long and no changes were saved. Please try again.',
        code: 'block_operation_timeout',
        retryable: true,
      });
      return;
    }
    res.status(500).json({
      error: 'Could not update your block settings. Please try again.',
      code: 'block_operation_failed',
      retryable: true,
    });
  }
};

export const unblockUser = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const blockedId = String(req.params.userId || '').trim();
    if (!blockedId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const blocks = await tx.user_blocks.findMany({
        where: { blockerId: userId, blockedId },
        select: {
          id: true,
          deviceScopes: { select: { installHash: true } },
        },
      });
      const installHashes = Array.from(new Set(
        blocks.flatMap((block) => block.deviceScopes.map((scope) => scope.installHash))
      ));
      const linkedUsers = installHashes.length > 0
        ? await tx.user_devices.findMany({
            where: { installHash: { in: installHashes } },
            select: { userId: true },
            distinct: ['userId'],
          })
        : [];
      const affectedUserIds = Array.from(new Set([
        blockedId,
        ...linkedUsers.map((row) => row.userId),
      ])).filter((id) => id && id !== userId);
      const conversations = await tx.conversations.findMany({
        where: {
          OR: [
            { participant1Id: userId, participant2Id: { in: affectedUserIds } },
            { participant1Id: { in: affectedUserIds }, participant2Id: userId },
          ],
        },
        select: { id: true },
      });
      const deleted = await tx.user_blocks.deleteMany({
        where: { blockerId: userId, blockedId },
      });
      return {
        deletedCount: deleted.count,
        affectedUserIds,
        affectedConversationIds: conversations.map((conversation) => conversation.id),
      };
    });

    if (result.deletedCount > 0) {
      invalidateMessageInteractionCache(userId, blockedId);
      await invalidateBlockedUserIdsCache(userId, ...result.affectedUserIds);
      await recordSafetyEvent({
        actorId: userId,
        targetUserId: blockedId,
        eventType: 'USER_UNBLOCKED',
      });
      emitSafetyStateChanged([userId, ...result.affectedUserIds]);
    }

    res.json({
      message: 'User unblocked',
      affectedConversationIds: result.affectedConversationIds,
    });
  } catch (error) {
    console.error('unblockUser error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
};
