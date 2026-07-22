import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest } from '../types/auth.types';
import {
  createUserBlockWithDeviceScope,
  invalidateMessageInteractionCache,
  publicTrustFields,
  recordSafetyEvent,
} from '../services/trust-safety.service';

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
    const { block, deviceScopeCount } = await createUserBlockWithDeviceScope({
      blockerId: userId,
      blockedId,
      reason,
    });

    await recordSafetyEvent({
      actorId: userId,
      targetUserId: blockedId,
      eventType: 'USER_BLOCKED',
      entityType: 'user_block',
      entityId: block.id,
      reason,
      metadata: { deviceScopeCount },
    });

    res.status(201).json({
      message: 'User blocked',
      block: {
        id: block.id,
        blockedUserId: block.blockedId,
        createdAt: block.createdAt.toISOString(),
        user: mapBlockedUser(target),
      },
    });
  } catch (error) {
    console.error('blockUser error:', error);
    res.status(500).json({ error: 'Failed to block user' });
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

    const deleted = await prisma.user_blocks.deleteMany({
      where: { blockerId: userId, blockedId },
    });

    if (deleted.count > 0) {
      invalidateMessageInteractionCache(userId, blockedId);
      await recordSafetyEvent({
        actorId: userId,
        targetUserId: blockedId,
        eventType: 'USER_UNBLOCKED',
      });
    }

    res.json({ message: 'User unblocked' });
  } catch (error) {
    console.error('unblockUser error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
};
