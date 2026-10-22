import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getBlockedUserIds, assertUsersCanInteract, areUsersBlocked, safetyErrorResponse } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { randomUUID } from "crypto";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { GroupInvite, mapGroupInvite, inviteExpiresAt, normalizeInviteAction } from "./invitation-support.controller";
import { selectGroupUser, normalizeOptionalString, invalidateGroupListCache } from "./support.controller";
import { hasGroupRoleAtLeast } from "./roles.controller";

/**
 * Get pending invites for the current user
 * GET /api/groups/invites/pending
 */
export const getUserPendingInvites = async (
  req: AuthenticatedRequest,
  res: Response<{ invites: GroupInvite[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const blockedUserIds = await getBlockedUserIds(userId);
    await prisma.group_invites.updateMany({
      where: {
        invitedUserId: userId,
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired', respondedAt: new Date() },
    });

    const invites = await prisma.group_invites.findMany({
      where: {
        invitedUserId: userId,
        ...(blockedUserIds.length > 0 ? { invitedById: { notIn: blockedUserIds } } : {}),
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        groups: true,
        invitedBy: { select: selectGroupUser },
        invitedUser: { select: selectGroupUser },
      },
    });

    res.status(200).json({ invites: invites.map(mapGroupInvite) });
  } catch (error) {
    console.error('Error fetching pending invites:', error);
    res.status(500).json({ error: 'Failed to fetch pending invites' });
  }
};

/**
 * Invite a user directly to a group
 * POST /api/groups/:groupId/invites
 */
export const createGroupInvite = async (
  req: AuthenticatedRequest,
  res: Response<{ invite: GroupInvite } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const invitedById = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const invitedUserId = ensureString(req.body?.userId) || ensureString(req.body?.invitedUserId);
    const message = normalizeOptionalString(req.body?.message);
    if (!groupId || !invitedUserId) {
      res.status(400).json({ error: 'Group ID and invited user ID are required' });
      return;
    }
    if (invitedById === invitedUserId) {
      res.status(400).json({ error: 'You cannot invite yourself' });
      return;
    }
    await assertUsersCanInteract(invitedById, invitedUserId, 'group invitation');

    const [group, inviterMembership, invitedUser, existingMembership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, name: true, creatorId: true, memberCount: true, maxMembers: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId: invitedById } } }),
      prisma.user.findFirst({ where: { id: invitedUserId, isBanned: false }, select: selectGroupUser }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId: invitedUserId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, inviterMembership, invitedById, 'admin')) {
      res.status(403).json({ error: 'Not authorized to invite users to this group' });
      return;
    }
    if (!invitedUser) {
      res.status(404).json({ error: 'Invited user not found' });
      return;
    }
    if (existingMembership) {
      res.status(400).json({ error: 'User is already a member of this group' });
      return;
    }
    if (group.memberCount >= group.maxMembers) {
      res.status(400).json({ error: 'Group is full' });
      return;
    }

    const invite = await prisma.group_invites.upsert({
      where: { groupId_invitedUserId: { groupId, invitedUserId } },
      update: {
        invitedById,
        status: 'pending',
        message,
        createdAt: new Date(),
        expiresAt: inviteExpiresAt(),
        respondedAt: null,
      },
      create: {
        id: randomUUID(),
        groupId,
        invitedUserId,
        invitedById,
        status: 'pending',
        message,
        expiresAt: inviteExpiresAt(),
      },
      include: {
        groups: true,
        invitedBy: { select: selectGroupUser },
        invitedUser: { select: selectGroupUser },
      },
    });

    if (!(await areUsersBlocked(invitedById, invitedUserId))) {
      pushNotificationService.pushStudyGroupInvite(invitedUserId, group.name, 'Someone', groupId).catch(() => undefined);
    }

    res.status(201).json({ invite: mapGroupInvite(invite) });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Error creating group invite:', error);
    res.status(500).json({ error: 'Failed to create group invite' });
  }
};

/**
 * Respond to a direct group invite
 * POST /api/groups/invites/:inviteId/respond
 */
export const respondToGroupInvite = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string; groupId: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const inviteId = ensureString(req.params.inviteId);
    const action = normalizeInviteAction(req.body?.action);
    if (!inviteId || !action) {
      res.status(400).json({ error: 'Invite ID and action are required' });
      return;
    }

    const invite = await prisma.group_invites.findUnique({
      where: { id: inviteId },
      include: { groups: { include: { group_members: { where: { userId } } } } },
    });

    if (!invite || invite.invitedUserId !== userId) {
      res.status(404).json({ error: 'Group invite not found' });
      return;
    }
    if (await areUsersBlocked(userId, invite.invitedById)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false } as any);
      return;
    }
    if (invite.status !== 'pending') {
      res.status(400).json({ error: 'This invite has already been handled' });
      return;
    }
    if (invite.expiresAt < new Date()) {
      await prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'expired', respondedAt: new Date() },
      });
      res.status(400).json({ error: 'This invite has expired' });
      return;
    }

    if (action === 'decline') {
      await prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'declined', respondedAt: new Date() },
      });
      res.status(200).json({ status: 'declined', message: 'Invite declined', groupId: invite.groupId });
      return;
    }

    const group = invite.groups as typeof invite.groups & { group_members: unknown[] };
    if (group.group_members.length > 0 || group.creatorId === userId) {
      await prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      res.status(200).json({ status: 'already_member', message: 'You are already a member of this group', groupId: invite.groupId });
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
          groupId: invite.groupId,
          userId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: invite.groupId },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
      prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'accepted', respondedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({ status: 'joined', message: 'Successfully joined the group', groupId: invite.groupId });
  } catch (error) {
    console.error('Error responding to group invite:', error);
    res.status(500).json({ error: 'Failed to respond to group invite' });
  }
};
