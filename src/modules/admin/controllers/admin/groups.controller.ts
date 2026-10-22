import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { getIO } from "../../../../realtime/socket-registry";
import { AuthRequest, normalizeOptionalString } from "./support.controller";
import { collectGroupChatMediaAssets, isGroupUploadUrl, deleteBunnyAssets } from "./media-cleanup.controller";

export // ============================================
// GROUPS
// ============================================

const mapAdminGroup = (group: any) => ({
  id: group.id,
  name: group.name,
  slug: group.slug,
  description: group.description,
  privacy: group.isPrivate ? 'private' : 'public',
  coverImage: group.coverImage || group.imageUrl || null,
  iconImage: group.iconImage || group.imageUrl || null,
  imageUrl: group.imageUrl || null,
  memberCount: group.memberCount,
  createdAt: group.createdAt,
  updatedAt: group.updatedAt,
  createdBy: group.users,
  _count: {
    members: group._count?.group_members ?? 0,
    posts: group._count?.group_messages ?? 0,
    messages: group._count?.group_messages ?? 0,
  },
});

export const getGroups = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [groups, total] = await Promise.all([
      prisma.groups.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          isPrivate: true,
          coverImage: true,
          iconImage: true,
          imageUrl: true,
          memberCount: true,
          createdAt: true,
          updatedAt: true,
          users: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
          _count: {
            select: {
              group_members: true,
              group_messages: true,
            },
          },
        },
      }),
      prisma.groups.count({ where }),
    ]);

    const mappedGroups = groups.map(mapAdminGroup);

    res.json({
      groups: mappedGroups,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getGroups error:', error);
    res.status(500).json({ error: 'Failed to load groups' });
  }
};

export const deleteGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        imageUrl: true,
        iconImage: true,
        coverImage: true,
        _count: {
          select: {
            group_members: true,
            group_messages: true,
          },
        },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const chatMediaAssets = await collectGroupChatMediaAssets(groupId);
    const groupImageUrls = [group.imageUrl, group.iconImage, group.coverImage]
      .filter(isGroupUploadUrl)
      .map((url) => url.trim());
    const assetUrls = Array.from(new Set([...chatMediaAssets.urls, ...groupImageUrls]));
    const mediaDeletion = await deleteBunnyAssets(assetUrls);

    if (mediaDeletion.failed > 0) {
      res.status(502).json({
        error: 'Some group media files could not be deleted. Database rows were left in place so the delete can be retried.',
        media: {
          filesFound: assetUrls.length,
          deleted: mediaDeletion.deleted,
          failed: mediaDeletion.failed,
          failedUrls: mediaDeletion.failedUrls,
        },
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.group_messages.updateMany({
        where: { groupId },
        data: { replyToId: null },
      });
      await tx.group_members.deleteMany({ where: { groupId } });
      await tx.groups.delete({ where: { id: groupId } });
    }, {
      maxWait: 15_000,
      timeout: 60_000,
    });

    getIO()?.to(`group:${groupId}`).emit('group:deleted', {
      groupId,
      deletedBy: String(req.user.userId),
      deletedAt: new Date().toISOString(),
    });

    res.json({
      message: 'Group deleted successfully',
      deleted: {
        groupId,
        members: group._count.group_members,
        messages: group._count.group_messages,
      },
      media: {
        filesFound: assetUrls.length,
        deleted: mediaDeletion.deleted,
        failed: mediaDeletion.failed,
      },
    });
  } catch (error) {
    console.error('deleteGroup error:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
};

export const getAdminGroupMembers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = normalizeOptionalString(req.query.search);
    const role = normalizeOptionalString(req.query.role);
    const skip = (page - 1) * limit;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isPrivate: true,
        imageUrl: true,
        iconImage: true,
        coverImage: true,
        memberCount: true,
        createdAt: true,
        updatedAt: true,
        users: {
          select: { id: true, name: true, username: true },
        },
        _count: {
          select: {
            group_members: true,
            group_messages: true,
          },
        },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const memberWhere: any = { groupId };
    if (role && role !== 'all') {
      memberWhere.role = role.toLowerCase();
    }

    if (search) {
      const matchedUsers = await prisma.user.findMany({
        where: {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
        take: 200,
      });
      memberWhere.userId = { in: matchedUsers.map((user) => user.id) };
    }

    const [members, total] = await Promise.all([
      prisma.group_members.findMany({
        where: memberWhere,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
      }),
      prisma.group_members.count({ where: memberWhere }),
    ]);

    const users = await prisma.user.findMany({
      where: { id: { in: members.map((member) => member.userId) } },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        profileImage: true,
        headline: true,
        isBanned: true,
      },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));

    res.json({
      group: mapAdminGroup(group),
      members: members.map((member) => ({
        id: member.id,
        groupId: member.groupId,
        userId: member.userId,
        role: member.role,
        joinedAt: member.joinedAt,
        isCreator: group.users?.id === member.userId,
        user: usersById.get(member.userId) || {
          id: member.userId,
          name: 'Unknown user',
          username: null,
          email: null,
          profileImage: null,
          headline: null,
          isBanned: false,
        },
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getAdminGroupMembers error:', error);
    res.status(500).json({ error: 'Failed to load group members' });
  }
};

export const updateAdminGroupMemberRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const userId = req.params.userId;
    const role = normalizeOptionalString(req.body?.role)?.toLowerCase();
    const allowedRoles = ['member', 'moderator', 'admin', 'owner'];

    if (!role || !allowedRoles.includes(role)) {
      res.status(400).json({ error: 'Choose a valid group role' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { creatorId: true },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (group.creatorId === userId && role !== 'owner') {
      res.status(400).json({ error: 'The group creator must remain owner' });
      return;
    }

    const member = await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: { role },
    });

    res.json({
      message: 'Member role updated successfully',
      member,
    });
  } catch (error) {
    console.error('updateAdminGroupMemberRole error:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

export const removeAdminGroupMember = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = req.params.id;
    const userId = req.params.userId;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, creatorId: true },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (group.creatorId === userId) {
      res.status(400).json({ error: 'Cannot remove the group creator. Delete the group instead.' });
      return;
    }

    const existingMember = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    if (!existingMember) {
      res.status(404).json({ error: 'Member not found in this group' });
      return;
    }

    const nextMemberCount = await prisma.$transaction(async (tx) => {
      await tx.group_members.delete({
        where: { groupId_userId: { groupId, userId } },
      });
      const memberCount = await tx.group_members.count({ where: { groupId } });
      await tx.groups.update({
        where: { id: groupId },
        data: { memberCount, updatedAt: new Date() },
      });
      return memberCount;
    });

    getIO()?.to(`group:${groupId}`).emit('group:member_removed', {
      groupId,
      userId,
      removedBy: String(req.user.userId),
      memberCount: nextMemberCount,
    });

    res.json({
      message: 'Member removed successfully',
      memberCount: nextMemberCount,
    });
  } catch (error) {
    console.error('removeAdminGroupMember error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};
