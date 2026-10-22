import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { evictUserFromGroupRoom } from "../../../../realtime/socket-registry";
import { canViewGroup } from "../../../../shared/utils/access-control.util";
import { invalidateGroupListCache } from "./support.controller";
import { mapRoleToEnum, normalizeGroupRole, getEffectiveGroupRole, GROUP_ROLE_RANK } from "./roles.controller";

/**
 * Join a group
 * POST /api/groups/:groupId/join
 */
export const joinGroup = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string } | ErrorResponse>
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

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      include: {
        group_members: { where: { userId } },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const groupWithMembers = group as typeof group & { group_members: unknown[] };
    if (groupWithMembers.group_members.length > 0) {
      res.status(400).json({ error: 'Already a member of this group' });
      return;
    }

    if (group.isPrivate) {
      res.status(403).json({ error: 'Private groups require an invitation' });
      return;
    }

    if (group.memberCount >= group.maxMembers) {
      res.status(400).json({ error: 'Group is full' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.create({
        data: {
          id: randomUUID(),
          groupId,
          userId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({
      status: 'joined',
      message: 'Successfully joined the group',
    });
  } catch (error) {
    console.error('Error joining group:', error);
    res.status(500).json({ error: 'Failed to join group' });
  }
};

/**
 * Leave a group
 * POST /api/groups/:groupId/leave
 */
export const leaveGroup = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
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

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group || !membership) {
      res.status(400).json({ error: 'Not a member of this group' });
      return;
    }
    if (group.creatorId === userId) {
      res.status(400).json({ error: 'Transfer ownership or delete the group before leaving' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.delete({
        where: { groupId_userId: { groupId, userId } },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { decrement: 1 }, updatedAt: new Date() },
      }),
    ]);

    await evictUserFromGroupRoom(groupId, userId);

    invalidateGroupListCache();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error leaving group:', error);
    res.status(500).json({ error: 'Failed to leave group' });
  }
};

/**
 * Get group members
 * GET /api/groups/:groupId/members
 */
export const getGroupMembers = async (
  req: AuthenticatedRequest,
  res: Response<{ members: any[]; pagination: any } | ErrorResponse>
): Promise<void> => {
  try {
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const page = Math.max(1, parseInt(ensureString(req.query.page) || '1') || 1);
    const limit = Math.min(50, Math.max(1, parseInt(ensureString(req.query.limit) || '20') || 20));
    const skip = (page - 1) * limit;
    const role = ensureString(req.query.role);
    const search = ensureString(req.query.search);
    const currentUserId = req.user?.userId ? String(req.user.userId) : null;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, isPrivate: true, creatorId: true },
    });
    if (!group || !(await canViewGroup(group, currentUserId))) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const where: any = { groupId };
    if (role) {
      where.role = role.toLowerCase();
    }

    const [members, total] = await Promise.all([
      prisma.group_members.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
      }),
      prisma.group_members.count({ where }),
    ]);

    // Fetch user data separately since there's no direct relation
    const userIds = members.map((m) => m.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, username: true, profileImage: true, headline: true, isVerified: true, profileBadgeStyle: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    const membersWithUsers = members
      .filter((m) => {
        if (!search) return true;
        const user = userMap.get(m.userId);
        if (!user) return false;
        return (
          user.name.toLowerCase().includes(search.toLowerCase()) ||
          user.username.toLowerCase().includes(search.toLowerCase())
        );
      })
      .map((m) => ({
        id: m.id,
        groupId: m.groupId,
        userId: m.userId,
        user: userMap.get(m.userId) || { id: m.userId, name: 'Unknown', username: 'unknown', profileImage: null },
        role: mapRoleToEnum(m.role),
        joinedAt: m.joinedAt.toISOString(),
        mutedUntil: null,
      }));

    res.status(200).json({
      members: membersWithUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching group members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
};

/**
 * Update member role
 * PUT /api/groups/:groupId/members/:userId
 */
export const updateMemberRole = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const userId = ensureString(req.params.userId);
    if (!groupId || !userId) {
      res.status(400).json({ error: 'Group ID and User ID are required' });
      return;
    }
    const { role } = req.body;
    const targetRole = normalizeGroupRole(role);
    if (!targetRole || targetRole === 'owner') {
      res.status(400).json({ error: 'Role must be member, moderator, or admin' });
      return;
    }

    if (currentUserId === userId) {
      res.status(400).json({ error: 'Use group ownership transfer or leave flow for your own role' });
      return;
    }

    const [group, currentMembership, targetMembership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId: currentUserId } },
      }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group || !targetMembership) {
      res.status(404).json({ error: 'Group member not found' });
      return;
    }
    if (group.creatorId === userId) {
      res.status(403).json({ error: 'The group owner role cannot be changed' });
      return;
    }

    const currentRole = getEffectiveGroupRole(group, currentMembership, currentUserId);
    const targetCurrentRole = getEffectiveGroupRole(group, targetMembership, userId);
    const currentRank = currentRole ? GROUP_ROLE_RANK[currentRole] : 0;
    const targetCurrentRank = targetCurrentRole ? GROUP_ROLE_RANK[targetCurrentRole] : 0;
    const targetRank = GROUP_ROLE_RANK[targetRole];

    if (currentRank < GROUP_ROLE_RANK.admin || currentRank <= targetCurrentRank || currentRank <= targetRank) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: { role: targetRole },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

/**
 * Remove member from group
 * DELETE /api/groups/:groupId/members/:userId
 */
export const removeMember = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const userId = ensureString(req.params.userId);
    if (!groupId || !userId) {
      res.status(400).json({ error: 'Group ID and User ID are required' });
      return;
    }

    if (currentUserId === userId) {
      res.status(400).json({ error: 'Use the leave group endpoint to remove yourself' });
      return;
    }

    const [group, currentMembership, targetMembership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId: currentUserId } },
      }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group || !targetMembership) {
      res.status(404).json({ error: 'Group member not found' });
      return;
    }
    if (group.creatorId === userId) {
      res.status(403).json({ error: 'The group owner cannot be removed' });
      return;
    }

    const currentRole = getEffectiveGroupRole(group, currentMembership, currentUserId);
    const targetRole = getEffectiveGroupRole(group, targetMembership, userId);
    const currentRank = currentRole ? GROUP_ROLE_RANK[currentRole] : 0;
    const targetRank = targetRole ? GROUP_ROLE_RANK[targetRole] : 0;

    if (currentRank < GROUP_ROLE_RANK.moderator || currentRank <= targetRank) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.delete({
        where: { groupId_userId: { groupId, userId } },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { decrement: 1 }, updatedAt: new Date() },
      }),
    ]);

    await evictUserFromGroupRoom(groupId, userId);

    invalidateGroupListCache();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};
