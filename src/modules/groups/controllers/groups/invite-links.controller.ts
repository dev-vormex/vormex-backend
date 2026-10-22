import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { buildInviteLinkResponse, canShareGroupInviteLink, normalizeInviteLinkVisibility, generateGroupInviteCode } from "./invitation-support.controller";
import { invalidateGroupListCache } from "./support.controller";
import { hasGroupRoleAtLeast } from "./roles.controller";

/**
 * Preview a group invite link
 * GET /api/groups/invites/link/:code
 */
export const getGroupInviteLinkPreview = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    const inviteCode = ensureString(req.params.code);
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const userId = req.user?.userId ? String(req.user.userId) : null;
    const group = await prisma.groups.findUnique({
      where: { inviteCode },
      include: {
        group_members: userId ? { where: { userId } } : false,
        _count: { select: { group_members: true } },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Invite link is invalid or has been reset' });
      return;
    }

    const groupWithMembership = group as typeof group & { group_members?: Array<{ role: string }> };
    const membership = Array.isArray(groupWithMembership.group_members) ? groupWithMembership.group_members[0] : null;

    res.status(200).json(buildInviteLinkResponse(group, userId, membership));
  } catch (error) {
    console.error('Error previewing group invite link:', error);
    res.status(500).json({ error: 'Failed to preview invite link' });
  }
};

/**
 * Join a group from an invite link
 * POST /api/groups/invites/link/:code/join
 */
export const joinGroupByInviteLink = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string; groupId: string; requestId?: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const inviteCode = ensureString(req.params.code);
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { inviteCode },
      include: { group_members: { where: { userId } } },
    });

    if (!group) {
      res.status(404).json({ error: 'Invite link is invalid or has been reset' });
      return;
    }

    const groupWithMembers = group as typeof group & { group_members: unknown[] };
    if (groupWithMembers.group_members.length > 0 || group.creatorId === userId) {
      res.status(200).json({
        status: 'already_member',
        message: 'You are already a member of this group',
        groupId: group.id,
      });
      return;
    }

    if (group.memberCount >= group.maxMembers) {
      res.status(400).json({ error: 'Group is full' });
      return;
    }

    if (group.isPrivate) {
      const request = await prisma.group_join_requests.upsert({
        where: { groupId_requesterId: { groupId: group.id, requesterId: userId } },
        update: {
          inviteCode,
          status: 'pending',
          requestedAt: new Date(),
          reviewedById: null,
          respondedAt: null,
        },
        create: {
          id: randomUUID(),
          groupId: group.id,
          requesterId: userId,
          inviteCode,
          status: 'pending',
        },
      });

      res.status(202).json({
        status: 'pending',
        message: 'Your request to join this group is waiting for admin approval',
        groupId: group.id,
        requestId: request.id,
      });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.create({
        data: {
          id: randomUUID(),
          groupId: group.id,
          userId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: group.id },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({
      status: 'joined',
      message: 'Successfully joined the group',
      groupId: group.id,
    });
  } catch (error) {
    console.error('Error joining group by invite link:', error);
    res.status(500).json({ error: 'Failed to join group from invite link' });
  }
};

/**
 * Get a group's invite link
 * GET /api/groups/:groupId/invite-link
 */
export const getGroupInviteLink = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
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
      prisma.groups.findUnique({
        where: { id: groupId },
        include: { _count: { select: { group_members: true } } },
      }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!canShareGroupInviteLink(group, membership, userId)) {
      res.status(403).json({ error: 'Not authorized to view this group invite link' });
      return;
    }

    res.status(200).json(buildInviteLinkResponse(group, userId, membership));
  } catch (error) {
    console.error('Error fetching group invite link:', error);
    res.status(500).json({ error: 'Failed to fetch invite link' });
  }
};

/**
 * Update invite link sharing settings
 * PATCH /api/groups/:groupId/invite-link/settings
 */
export const updateGroupInviteLinkSettings = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
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

    const visibility = normalizeInviteLinkVisibility(req.body?.visibility);
    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true, inviteLinkVisibility: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to update invite link settings' });
      return;
    }

    const updateData: any = {
      inviteLinkVisibility: visibility,
      inviteLinkUpdatedAt: new Date(),
      updatedAt: new Date(),
    };
    if (visibility === 'ADMINS' && normalizeInviteLinkVisibility(group.inviteLinkVisibility) === 'MEMBERS') {
      updateData.inviteCode = generateGroupInviteCode();
    }

    const updatedGroup = await prisma.groups.update({
      where: { id: groupId },
      data: updateData,
      include: { _count: { select: { group_members: true } } },
    });

    res.status(200).json(buildInviteLinkResponse(updatedGroup, userId, membership));
  } catch (error) {
    console.error('Error updating group invite link settings:', error);
    res.status(500).json({ error: 'Failed to update invite link settings' });
  }
};

/**
 * Reset a group's invite link
 * POST /api/groups/:groupId/invite-link/reset
 */
export const resetGroupInviteLink = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
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
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to reset this invite link' });
      return;
    }

    const updatedGroup = await prisma.groups.update({
      where: { id: groupId },
      data: {
        inviteCode: generateGroupInviteCode(),
        inviteLinkUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
      include: { _count: { select: { group_members: true } } },
    });

    res.status(200).json(buildInviteLinkResponse(updatedGroup, userId, membership));
  } catch (error) {
    console.error('Error resetting group invite link:', error);
    res.status(500).json({ error: 'Failed to reset invite link' });
  }
};
