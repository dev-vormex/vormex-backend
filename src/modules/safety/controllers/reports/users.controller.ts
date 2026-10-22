import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { canViewGroup } from "../../../../shared/utils/access-control.util";
import { AuthRequest, createReportWithSafety, wantsBlockAfterReport, normalizeReason, truncateText, handleReportError } from "./support.controller";

export const reportUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const reportedUserId = String(req.params.userId ?? '');
    if (!reportedUserId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }
    const { reason, description, blockUser } = req.body;

    if (reportedUserId === userId) {
      res.status(400).json({ error: 'Cannot report yourself' });
      return;
    }

    const target = await prisma.user.findUnique({
      where: { id: reportedUserId },
      select: {
        id: true,
        name: true,
        username: true,
        headline: true,
        bio: true,
        college: true,
        branch: true,
        identityTrustLevel: true,
        isVerified: true,
        createdAt: true,
      },
    });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const row = await createReportWithSafety({
      reporterId: userId,
      reportedUserId,
      blockUser: wantsBlockAfterReport(blockUser),
      data: {
        reportType: 'USER',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedUserId,
        evidenceSnapshot: {
          user: {
            id: target.id,
            name: target.name,
            username: target.username,
            headline: truncateText(target.headline, 500),
            bio: truncateText(target.bio),
            college: target.college,
            branch: target.branch,
            identityTrustLevel: target.identityTrustLevel,
            isVerified: target.isVerified,
            createdAt: target.createdAt.toISOString(),
          },
        },
      },
    });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    handleReportError(res, error, 'reportUser');
  }
};

export const reportGroup = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const groupId = String(req.params.groupId ?? '');
    if (!groupId) {
      res.status(400).json({ error: 'groupId required' });
      return;
    }
    const { reason, description } = req.body;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        description: true,
        isPrivate: true,
        creatorId: true,
        memberCount: true,
        createdAt: true,
      },
    });
    if (!group || !(await canViewGroup(group, userId))) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const row = await createReportWithSafety({
      reporterId: userId,
      reportedUserId: group.creatorId,
      data: {
        reportType: 'GROUP',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedGroupId: groupId,
        reportedUserId: group.creatorId,
        evidenceSnapshot: {
          group: {
            id: group.id,
            name: group.name,
            description: truncateText(group.description),
            creatorId: group.creatorId,
            isPrivate: group.isPrivate,
            memberCount: group.memberCount,
            createdAt: group.createdAt.toISOString(),
          },
        },
      },
    });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    handleReportError(res, error, 'reportGroup');
  }
};
