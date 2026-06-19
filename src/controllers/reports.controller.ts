import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { canViewGroup, canViewPost } from '../utils/access-control.util';
import {
  createUserBlockWithDeviceScope,
  enforceTrustTierLimit,
  recordSafetyEvent,
  safetyErrorResponse,
} from '../services/trust-safety.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

const REPORT_REASONS = [
  { id: 'spam', label: 'Spam', description: 'Unwanted commercial content or spam' },
  { id: 'harassment', label: 'Harassment', description: 'Bullying or harassment' },
  { id: 'hate_speech', label: 'Hate Speech', description: 'Hateful or discriminatory content' },
  { id: 'violence', label: 'Violence', description: 'Violent or graphic content' },
  { id: 'inappropriate', label: 'Inappropriate', description: 'Inappropriate or adult content' },
  { id: 'misinformation', label: 'Misinformation', description: 'False or misleading information' },
  { id: 'impersonation', label: 'Impersonation', description: 'Pretending to be someone else' },
  { id: 'other', label: 'Other', description: 'Other violation' },
];

const normalizeReason = (raw: unknown): string => {
  if (typeof raw !== 'string' || !raw.trim()) return 'other';
  return raw.trim().slice(0, 500);
};

const truncateText = (value: unknown, max = 1200): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
};

const wantsBlockAfterReport = (raw: unknown): boolean => raw === true || raw === 'true';

const handleReportError = (res: Response, error: unknown, label: string): void => {
  const safety = safetyErrorResponse(error);
  if (safety) {
    res.status(safety.statusCode).json(safety.body);
    return;
  }
  console.error(`${label} error:`, error);
  res.status(500).json({ error: 'Failed to submit report' });
};

async function createReportWithSafety(params: {
  reporterId: string;
  reportedUserId?: string | null;
  blockUser?: boolean;
  data: Record<string, unknown>;
}) {
  await enforceTrustTierLimit(params.reporterId, 'report');

  const [reporterPriorReports, reportedUserPriorReports] = await Promise.all([
    prisma.moderation_reports.count({ where: { reporterId: params.reporterId } }),
    params.reportedUserId
      ? prisma.moderation_reports.count({ where: { reportedUserId: params.reportedUserId } })
      : Promise.resolve(0),
  ]);

  return prisma.$transaction(async (tx) => {
    const canBlock = Boolean(
      params.blockUser &&
        params.reportedUserId &&
        params.reportedUserId !== params.reporterId
    );

    const row = await tx.moderation_reports.create({
      data: {
        ...params.data,
        reporterPriorReports,
        reportedUserPriorReports,
        blockedUserAfterReport: canBlock,
      } as any,
    });

    if (canBlock && params.reportedUserId) {
      const { block, deviceScopeCount } = await createUserBlockWithDeviceScope({
        blockerId: params.reporterId,
        blockedId: params.reportedUserId,
        reason: `Report ${row.id}`,
        tx,
      });
      await recordSafetyEvent({
        actorId: params.reporterId,
        targetUserId: params.reportedUserId,
        eventType: 'USER_BLOCKED',
        entityType: 'user_block',
        entityId: block.id,
        reason: 'Report and block',
        metadata: { deviceScopeCount },
        tx,
      });
    }

    await recordSafetyEvent({
      actorId: params.reporterId,
      targetUserId: params.reportedUserId || null,
      eventType: 'REPORT_CREATED',
      entityType: 'moderation_report',
      entityId: row.id,
      reason: String(params.data.reason || 'other'),
      metadata: {
        reportType: params.data.reportType,
        blockedUserAfterReport: canBlock,
      },
      tx,
    });

    return row;
  });
}

export const getReportReasons = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ reasons: REPORT_REASONS });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report reasons' });
  }
};

export const reportPost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const postId = String(req.params.postId ?? '');
    if (!postId) {
      res.status(400).json({ error: 'postId required' });
      return;
    }
    const { reason, description, blockUser } = req.body;

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        authorId: true,
        content: true,
        type: true,
        visibility: true,
        isActive: true,
        createdAt: true,
      },
    });
    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const row = await createReportWithSafety({
      reporterId: userId,
      reportedUserId: post.authorId,
      blockUser: wantsBlockAfterReport(blockUser),
      data: {
        reportType: 'POST',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedPostId: postId,
        reportedUserId: post.authorId,
        evidenceSnapshot: {
          post: {
            id: post.id,
            authorId: post.authorId,
            content: truncateText(post.content),
            type: post.type,
            visibility: post.visibility,
            isActive: post.isActive,
            createdAt: post.createdAt.toISOString(),
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
    handleReportError(res, error, 'reportPost');
  }
};

export const reportComment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const commentId = String(req.params.commentId ?? '');
    if (!commentId) {
      res.status(400).json({ error: 'commentId required' });
      return;
    }
    const { reason, description, blockUser } = req.body;

    const comment = await prisma.post_comments.findUnique({
      where: { id: commentId },
      include: {
        posts: { select: { authorId: true, visibility: true, isActive: true } },
      },
    });
    if (!comment || !(await canViewPost(comment.posts, userId))) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    const row = await createReportWithSafety({
      reporterId: userId,
      reportedUserId: comment.authorId,
      blockUser: wantsBlockAfterReport(blockUser),
      data: {
        reportType: 'COMMENT',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedCommentId: commentId,
        reportedUserId: comment.authorId,
        evidenceSnapshot: {
          comment: {
            id: comment.id,
            postId: comment.postId,
            authorId: comment.authorId,
            parentId: comment.parentId,
            content: truncateText(comment.content),
            createdAt: comment.createdAt.toISOString(),
          },
          post: {
            id: comment.postId,
            authorId: comment.posts.authorId,
            visibility: comment.posts.visibility,
            isActive: comment.posts.isActive,
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
    handleReportError(res, error, 'reportComment');
  }
};

export const reportChat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const conversationId = String(req.params.conversationId ?? '');
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    const { reason, description, messageIds, blockUser } = req.body;

    const conv = await prisma.conversations.findUnique({ where: { id: conversationId } });
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (conv.participant1Id !== userId && conv.participant2Id !== userId) {
      res.status(403).json({ error: 'Not a participant in this conversation' });
      return;
    }

    const reportedUserId =
      conv.participant1Id === userId ? conv.participant2Id : conv.participant1Id;

    const existingOpenReport = await prisma.moderation_reports.findFirst({
      where: {
        reporterId: userId,
        reportType: 'CHAT',
        conversationId,
        status: { in: ['PENDING', 'UNDER_REVIEW'] },
      },
      select: {
        id: true,
        status: true,
        blockedUserAfterReport: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingOpenReport) {
      let blockedUserAfterReport = existingOpenReport.blockedUserAfterReport;
      if (wantsBlockAfterReport(blockUser) && !blockedUserAfterReport) {
        await prisma.$transaction(async (tx) => {
          const { block, deviceScopeCount } = await createUserBlockWithDeviceScope({
            blockerId: userId,
            blockedId: reportedUserId,
            reason: `Report ${existingOpenReport.id}`,
            tx,
          });
          await tx.moderation_reports.update({
            where: { id: existingOpenReport.id },
            data: { blockedUserAfterReport: true },
          });
          await recordSafetyEvent({
            actorId: userId,
            targetUserId: reportedUserId,
            eventType: 'USER_BLOCKED',
            entityType: 'user_block',
            entityId: block.id,
            reason: 'Report and block',
            metadata: { deviceScopeCount },
            tx,
          });
        });
        blockedUserAfterReport = true;
      }

      res.json({
        success: true,
        message: 'You already submitted a report for this conversation. It is under review.',
        reportId: existingOpenReport.id,
        alreadyReported: true,
        status: existingOpenReport.status,
        blockedUserAfterReport,
      });
      return;
    }

    const reportMessageIds = Array.isArray(messageIds)
      ? messageIds.map(String).filter(Boolean).slice(0, 50)
      : [];
    if (reportMessageIds.length > 0) {
      const matchingMessages = await prisma.messages.count({
        where: { id: { in: reportMessageIds }, conversationId },
      });
      if (matchingMessages !== new Set(reportMessageIds).size) {
        res.status(400).json({ error: 'One or more messages do not belong to this conversation' });
        return;
      }
    }

    const messageExcerpts = reportMessageIds.length > 0
      ? await prisma.messages.findMany({
          where: { id: { in: reportMessageIds }, conversationId },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: {
            id: true,
            senderId: true,
            receiverId: true,
            content: true,
            contentType: true,
            mediaType: true,
            isDeleted: true,
            createdAt: true,
          },
        })
      : [];
    const extra = reportMessageIds.length > 0 ? { messageIds: reportMessageIds } : undefined;

    const row = await createReportWithSafety({
      reporterId: userId,
      reportedUserId,
      blockUser: wantsBlockAfterReport(blockUser),
      data: {
        reportType: 'CHAT',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        conversationId,
        reportedUserId,
        extra: extra ?? undefined,
        evidenceSnapshot: {
          conversation: {
            id: conversationId,
            participant1Id: conv.participant1Id,
            participant2Id: conv.participant2Id,
          },
          messages: messageExcerpts.map((message) => ({
            id: message.id,
            senderId: message.senderId,
            receiverId: message.receiverId,
            content: truncateText(message.content),
            contentType: message.contentType,
            mediaType: message.mediaType,
            isDeleted: message.isDeleted,
            createdAt: message.createdAt.toISOString(),
          })),
        },
      },
    });

    console.log('[reports] CHAT report saved', { id: row.id, conversationId, reporterId: userId });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    handleReportError(res, error, 'reportChat');
  }
};

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

export const getMyReports = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 10, 50);
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.moderation_reports.findMany({
        where: { reporterId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          reportType: true,
          reason: true,
          status: true,
          conversationId: true,
          reportedPostId: true,
          reportedCommentId: true,
          reportedUserId: true,
          reportedGroupId: true,
          blockedUserAfterReport: true,
          createdAt: true,
        },
      }),
      prisma.moderation_reports.count({ where: { reporterId: userId } }),
    ]);

    res.json({
      reports: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error('getMyReports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
};
