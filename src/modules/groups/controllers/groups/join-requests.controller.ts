import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { GroupJoinRequest, selectGroupUser, mapGroupJoinRequest, invalidateGroupListCache } from "./support.controller";
import { hasGroupRoleAtLeast } from "./roles.controller";
import { normalizeInviteAction } from "./invitation-support.controller";

/**
 * Get pending join requests for a private/secret group
 * GET /api/groups/:groupId/join-requests
 */
export const getGroupJoinRequests = async (
  req: AuthenticatedRequest,
  res: Response<{ requests: GroupJoinRequest[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const status = ensureString(req.query.status) || 'pending';
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
      res.status(403).json({ error: 'Not authorized to view join requests' });
      return;
    }

    const requests = await prisma.group_join_requests.findMany({
      where: { groupId, status: status.toLowerCase() },
      orderBy: { requestedAt: 'desc' },
      include: { requester: { select: selectGroupUser } },
    });

    res.status(200).json({ requests: requests.map(mapGroupJoinRequest) });
  } catch (error) {
    console.error('Error fetching group join requests:', error);
    res.status(500).json({ error: 'Failed to fetch join requests' });
  }
};

/**
 * Respond to a private/secret group join request
 * POST /api/groups/:groupId/join-requests/:requestId/respond
 */
export const respondToGroupJoinRequest = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string; groupId: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const reviewedById = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const requestId = ensureString(req.params.requestId);
    const action = normalizeInviteAction(req.body?.action);
    if (!groupId || !requestId || !action) {
      res.status(400).json({ error: 'Group ID, request ID, and action are required' });
      return;
    }

    const [group, reviewerMembership, joinRequest] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true, memberCount: true, maxMembers: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId: reviewedById } } }),
      prisma.group_join_requests.findUnique({ where: { id: requestId } }),
    ]);

    if (!group || !joinRequest || joinRequest.groupId !== groupId) {
      res.status(404).json({ error: 'Join request not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, reviewerMembership, reviewedById, 'admin')) {
      res.status(403).json({ error: 'Not authorized to manage join requests' });
      return;
    }
    if (joinRequest.status !== 'pending') {
      res.status(400).json({ error: 'This join request has already been handled' });
      return;
    }

    if (action === 'decline') {
      await prisma.group_join_requests.update({
        where: { id: requestId },
        data: { status: 'declined', reviewedById, respondedAt: new Date() },
      });
      res.status(200).json({ status: 'declined', message: 'Join request declined', groupId });
      return;
    }

    const existingMembership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId: joinRequest.requesterId } },
    });
    if (existingMembership || group.creatorId === joinRequest.requesterId) {
      await prisma.group_join_requests.update({
        where: { id: requestId },
        data: { status: 'accepted', reviewedById, respondedAt: new Date() },
      });
      res.status(200).json({ status: 'already_member', message: 'Requester is already a member', groupId });
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
          userId: joinRequest.requesterId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
      prisma.group_join_requests.update({
        where: { id: requestId },
        data: { status: 'accepted', reviewedById, respondedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({ status: 'joined', message: 'Join request approved', groupId });
  } catch (error) {
    console.error('Error responding to group join request:', error);
    res.status(500).json({ error: 'Failed to respond to join request' });
  }
};
