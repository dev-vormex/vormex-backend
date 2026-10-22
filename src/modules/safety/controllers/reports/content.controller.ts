import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { canViewPost } from "../../../../shared/utils/access-control.util";
import { AuthRequest, createReportWithSafety, wantsBlockAfterReport, normalizeReason, truncateText, handleReportError } from "./support.controller";

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
