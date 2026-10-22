import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { prismaRead } from "../../../../config/prisma";
import { canViewPost } from "../../../../shared/utils/access-control.util";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { AuthRequest } from "./support.controller";

// Get comments
export const getComments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const currentUserId = String(req.user.userId);
    const postId = ensureString(req.params.postId);
    const parentId = ensureString(req.query.parentId) || undefined;
    const page = Math.max(1, parseInt(ensureString(req.query.page) || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(ensureString(req.query.limit) || '20', 10)));

    if (!postId) {
      res.status(400).json({ error: 'Post ID is required' });
      return;
    }

    const post = await prismaRead.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });
    if (!post || !(await canViewPost(post, currentUserId))) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const blockedUserIds = await getBlockedUserIds(currentUserId);
    const where = {
      postId: postId as string,
      parentId: parentId || null,
      ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
    };
    const [comments, total] = await Promise.all([
      prismaRead.post_comments.findMany({
        where,
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              isVerified: true,
              profileBadgeStyle: true,
            },
          },
          _count: { select: { other_post_comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit + 1,
      }),
      prismaRead.post_comments.count({ where }),
    ]);

    // Fetch current user's likes for these comments (separate query to avoid filtered relation issues)
    const commentIds = comments.map((c) => c.id);
    const userLikes = commentIds.length > 0
      ? await prismaRead.comment_likes.findMany({
          where: { commentId: { in: commentIds }, userId: currentUserId },
          select: { commentId: true },
        })
      : [];
    const likedCommentIds = new Set(userLikes.map((l) => l.commentId));

    const hasMore = comments.length > limit;
    const items = hasMore ? comments.slice(0, limit) : comments;
    
    // Fetch replies for top-level comments (only if not fetching replies specifically)
    const topLevelCommentIds = items.map((c) => c.id);
    let repliesMap: Map<string, typeof items> = new Map();
    
    if (!parentId && topLevelCommentIds.length > 0) {
      const replies = await prismaRead.post_comments.findMany({
        where: {
          postId: postId as string,
          parentId: { in: topLevelCommentIds },
          ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
        },
        include: {
          users: {
            select: {
              id: true,
              username: true,
              name: true,
              profileImage: true,
              isVerified: true,
              profileBadgeStyle: true,
            },
          },
          _count: { select: { other_post_comments: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100, // Limit total replies fetched
      });
      
      // Get likes for replies too
      const replyIds = replies.map((r) => r.id);
      if (replyIds.length > 0) {
        const replyLikes = await prismaRead.comment_likes.findMany({
          where: { commentId: { in: replyIds }, userId: currentUserId },
          select: { commentId: true },
        });
        replyLikes.forEach((l) => likedCommentIds.add(l.commentId));
      }
      
      // Group replies by parent
      replies.forEach((r) => {
        if (r.parentId) {
          const existing = repliesMap.get(r.parentId) || [];
          existing.push(r);
          repliesMap.set(r.parentId, existing);
        }
      });
    }
    
    // Helper to map a comment
    const mapComment = (c: typeof items[0], includeReplies: boolean = false): Record<string, unknown> => {
      const cWithRelations = c as typeof c & { users: unknown; _count: { other_post_comments: number } };
      const author = cWithRelations.users ?? {
        id: c.authorId,
        username: 'unknown',
        name: 'Unknown User',
        profileImage: null,
      };
      
      const mapped: Record<string, unknown> = {
        id: c.id,
        postId: c.postId,
        parentId: c.parentId,
        authorId: c.authorId,
        author,
        content: c.content,
        contentType: 'text/plain',
        mentions: [],
        likesCount: c.likesCount,
        replyCount: cWithRelations._count?.other_post_comments ?? 0,
        isLiked: likedCommentIds.has(c.id),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
      
      if (includeReplies && repliesMap.has(c.id)) {
        mapped.replies = repliesMap.get(c.id)!.map((r) => mapComment(r, false));
      } else {
        mapped.replies = [];
      }
      
      return mapped;
    };

    const mapped = items.map((c) => mapComment(c, !parentId));

    res.json({ comments: mapped, total, hasMore });
  } catch (error) {
    const err = error as Error;
    console.error('getComments error:', err?.message ?? error);
    console.error('getComments stack:', err?.stack);
    const message = process.env.NODE_ENV !== 'production' && err?.message
      ? err.message
      : 'Failed to fetch comments';
    res.status(500).json({ error: message });
  }
};
