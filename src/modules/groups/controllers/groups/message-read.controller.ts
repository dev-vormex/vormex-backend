import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";

/**
 * Get group messages
 * GET /api/groups/:groupId/messages
 */
export const getGroupMessages = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const limit = Math.min(50, Math.max(1, parseInt(ensureString(req.query.limit) || '50', 10) || 50));
    const before = ensureString(req.query.before);

    // Verify user is member of group
    const membership = await prisma.group_members.findUnique({
      where: {
        groupId_userId: { groupId, userId: String(req.user.userId) },
      },
    });

    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const whereClause: any = { groupId, isDeleted: false };
    if (before) {
      whereClause.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.group_messages.findMany({
      where: whereClause,
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            isVerified: true,
            profileBadgeStyle: true,
          },
        },
        group_messages: {
          select: {
            id: true,
            content: true,
            senderId: true,
            users: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        group_message_reactions: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Return in chronological order (oldest first for display)
    const formatted = messages.reverse().map(msg => ({
      id: msg.id,
      groupId: msg.groupId,
      senderId: msg.senderId,
      sender: msg.users,
      content: msg.content,
      contentType: msg.contentType,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      replyToId: msg.replyToId,
      replyTo: msg.group_messages ? { id: msg.group_messages.id, content: msg.group_messages.content, senderId: msg.group_messages.senderId, sender: msg.group_messages.users } : null,
      reactions: msg.group_message_reactions,
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString(),
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching group messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};
