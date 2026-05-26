import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { canViewGroup, canViewPost } from '../utils/access-control.util';

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
    const { reason, description } = req.body;

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, userId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const row = await prisma.moderation_reports.create({
      data: {
        reportType: 'POST',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedPostId: postId,
        reportedUserId: post.authorId,
      },
    });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    console.error('reportPost error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
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
    const { reason, description } = req.body;

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

    const row = await prisma.moderation_reports.create({
      data: {
        reportType: 'COMMENT',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedCommentId: commentId,
        reportedUserId: comment.authorId,
      },
    });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    console.error('reportComment error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
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
    const { reason, description, messageIds } = req.body;

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

    const extra = reportMessageIds.length > 0 ? { messageIds: reportMessageIds } : undefined;

    const row = await prisma.moderation_reports.create({
      data: {
        reportType: 'CHAT',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        conversationId,
        reportedUserId,
        extra: extra ?? undefined,
      },
    });

    console.log('[reports] CHAT report saved', { id: row.id, conversationId, reporterId: userId });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    console.error('reportChat error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
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
    const { reason, description } = req.body;

    if (reportedUserId === userId) {
      res.status(400).json({ error: 'Cannot report yourself' });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id: reportedUserId } });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const row = await prisma.moderation_reports.create({
      data: {
        reportType: 'USER',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedUserId,
      },
    });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    console.error('reportUser error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
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
      select: { id: true, isPrivate: true, creatorId: true },
    });
    if (!group || !(await canViewGroup(group, userId))) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const row = await prisma.moderation_reports.create({
      data: {
        reportType: 'GROUP',
        reporterId: userId,
        reason: normalizeReason(reason),
        description: typeof description === 'string' ? description.slice(0, 5000) : null,
        reportedGroupId: groupId,
      },
    });

    res.json({
      success: true,
      message: 'Report submitted successfully. Our team will review it within 24 hours.',
      reportId: row.id,
    });
  } catch (error) {
    console.error('reportGroup error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
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
