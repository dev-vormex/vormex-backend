import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { selectGroupUser, GroupMessageShortcut, mapUser, generateSlug, mapGroupPrivacy } from "./support.controller";
import { mapRoleToEnum, getEffectiveGroupRole } from "./roles.controller";

export const buildGroupMessagePreview = (content: string, contentType: string): string => {
  if (content && content.trim()) {
    return content.trim();
  }

  switch (contentType) {
    case 'image':
      return 'Sent a photo';
    case 'video':
      return 'Sent a video';
    case 'file':
      return 'Sent a file';
    case 'audio':
      return 'Sent a voice message';
    default:
      return 'Sent a message';
  }
};

export const groupShortcutInclude = {
  groups: {
    include: {
      _count: { select: { group_members: true } },
      group_messages: {
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        include: {
          users: { select: selectGroupUser },
        },
      },
    },
  },
};

export const mapGroupMessageShortcut = (membership: any): GroupMessageShortcut => {
  const group = membership.groups;
  const latestMessage = Array.isArray(group.group_messages) ? group.group_messages[0] : null;
  const addedAtDate = membership.messagesAddedAt ?? membership.joinedAt ?? group.createdAt ?? new Date();
  const lastActivityDate = latestMessage?.createdAt ?? membership.messagesAddedAt ?? membership.joinedAt ?? group.updatedAt ?? addedAtDate;
  const sender = latestMessage?.users ? mapUser(latestMessage.users) : null;

  return {
    id: group.id,
    groupId: group.id,
    name: group.name,
    slug: generateSlug(group.name),
    description: group.description,
    coverImage: group.coverImage ?? group.imageUrl,
    iconImage: group.iconImage ?? group.imageUrl,
    privacy: mapGroupPrivacy(group.isPrivate),
    memberCount: group._count?.group_members ?? group.memberCount ?? 0,
    memberRole: mapRoleToEnum(getEffectiveGroupRole(group, membership, membership.userId) || membership.role),
    addedAt: addedAtDate.toISOString(),
    lastActivityAt: lastActivityDate.toISOString(),
    latestMessage: latestMessage ? {
      id: latestMessage.id,
      content: latestMessage.content,
      contentType: latestMessage.contentType,
      preview: buildGroupMessagePreview(latestMessage.content, latestMessage.contentType),
      senderId: latestMessage.senderId,
      senderName: sender?.name || sender?.username || 'Someone',
      createdAt: latestMessage.createdAt.toISOString(),
    } : null,
    isAddedToMessages: true,
  };
};

/**
 * List the current user's personal group shortcuts in Messages.
 * GET /api/groups/message-shortcuts
 */
export const getGroupMessageShortcuts = async (
  req: AuthenticatedRequest,
  res: Response<{ shortcuts: GroupMessageShortcut[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const memberships = await prisma.group_members.findMany({
      where: {
        userId,
        showInMessages: true,
      },
      include: groupShortcutInclude,
      orderBy: [
        { messagesAddedAt: 'desc' },
        { joinedAt: 'desc' },
      ],
    });

    const shortcuts = memberships
      .map(mapGroupMessageShortcut)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

    res.status(200).json({ shortcuts });
  } catch (error) {
    console.error('Error fetching group message shortcuts:', error);
    res.status(500).json({ error: 'Failed to fetch group message shortcuts' });
  }
};

/**
 * Toggle the current user's personal group shortcut in Messages.
 * PATCH /api/groups/:groupId/message-shortcut
 */
export const updateGroupMessageShortcut = async (
  req: AuthenticatedRequest,
  res: Response<{ groupId: string; enabled: boolean; shortcut: GroupMessageShortcut | null } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    const enabled = req.body.enabled;
    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const updatedMembership = await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: {
        showInMessages: enabled,
        messagesAddedAt: enabled ? (membership.messagesAddedAt ?? new Date()) : null,
      },
      include: groupShortcutInclude,
    });

    res.status(200).json({
      groupId,
      enabled,
      shortcut: enabled ? mapGroupMessageShortcut(updatedMembership) : null,
    });
  } catch (error) {
    console.error('Error updating group message shortcut:', error);
    res.status(500).json({ error: 'Failed to update group message shortcut' });
  }
};
