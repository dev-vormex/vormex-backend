import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prisma } from "../../../../config/prisma";
import { canViewReel } from "../../../../shared/utils/access-control.util";
import { AuthRequest, reelCommentAuthorSelect, mapReelComment } from "./support.controller";

export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const reelId = ensureString(req.params.reelId);
    if (!reelId) {
      res.status(400).json({ error: 'Reel ID is required' });
      return;
    }
    const parentId = ensureString(req.query.parentId) || undefined;
    const cursor = ensureString(req.query.cursor);
    const highlightCommentId = ensureString(req.query.highlightCommentId) || ensureString(req.query.commentId);
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);

    const reel = await prisma.reels.findUnique({
      where: { id: reelId },
      select: {
        id: true,
        authorId: true,
        visibility: true,
        status: true,
        publishedAt: true,
        allowComments: true,
      },
    });

    if (!reel || !(await canViewReel(reel, currentUserId))) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    const where: any = { reelId, parentId: parentId || null };
    const commentInclude = {
      users: { select: reelCommentAuthorSelect },
      ...(currentUserId
        ? {
            reel_comment_likes: {
              where: { userId: currentUserId },
              select: { userId: true },
            },
          }
        : {}),
      _count: { select: { other_reel_comments: true } },
    };

    const comments = await prisma.reel_comments.findMany({
      where,
      include: commentInclude,
      orderBy: [{ isPinned: 'desc' }, { likesCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = comments.length > limit;
    let items = hasMore ? comments.slice(0, limit) : comments;

    if (highlightCommentId) {
      const focus = await prisma.reel_comments.findFirst({
        where: { id: highlightCommentId, reelId },
        select: { id: true, parentId: true },
      });
      const focusListId = parentId ? focus?.id : (focus?.parentId || focus?.id);
      const belongsInList = parentId
        ? focus?.parentId === parentId
        : focus && !parentId;

      if (focusListId && belongsInList) {
        const focusedComment = await prisma.reel_comments.findFirst({
          where: {
            id: focusListId,
            reelId,
            parentId: parentId || null,
          },
          include: commentInclude,
        });

        if (focusedComment) {
          items = [
            focusedComment,
            ...items.filter((comment) => comment.id !== focusedComment.id),
          ].slice(0, limit);
        }
      }
    }

    res.json({
      comments: items.map((comment) => mapReelComment(comment, currentUserId)),
      nextCursor: hasMore ? items[items.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    console.error('getComments error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
};
