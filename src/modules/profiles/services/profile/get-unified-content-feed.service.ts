import { prisma } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import type { UnifiedContentItem, UnifiedFeedResponse } from "../../types/profile.types";
import { buildPostVisibilityWhere } from "../../../../shared/utils/access-control.util";
import { formatUnifiedItem } from "./normalize-profile-cache-identifier.service";

/**
 * Get unified content feed for a user
 * Combines posts, articles, forum Q&A in chronological order
 * 
 * @param userId - User ID
 * @param page - Page number (default: 1)
 * @param limit - Items per page (default: 20)
 * @param filter - Content type filter (default: 'all')
 * @returns UnifiedFeedResponse with paginated items
 */
export async function getUnifiedContentFeed(
  userId: string,
  page: number = 1,
  limit: number = 20,
  filter?: 'all' | 'posts' | 'articles' | 'forum' | 'videos',
  requestingUserId?: string | null
): Promise<UnifiedFeedResponse> {
  try {
    const cacheKey = `profile:feed:${requestingUserId || 'anon'}:${userId}:${filter || 'all'}:${page}:${limit}`;
    if (page === 1) {
      const cached = await cacheService.get<UnifiedFeedResponse>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const skip = (page - 1) * limit;
    // Fetch through the requested page plus one sentinel item. A fixed per-type cap
    // made profiles with more than 100 items report that no additional activity existed.
    const queryTake = skip + limit + 1;
    const allItems: UnifiedContentItem[] = [];

    // Query different content types based on filter
    // Video posts and dedicated Reel rows both belong in the Android "Reels" tab.
    const shouldFetchPosts = !filter || filter === 'all' || filter === 'posts' || filter === 'videos';
    const shouldFetchReels = !filter || filter === 'all' || filter === 'videos';
    const shouldFetchArticles = !filter || filter === 'all' || filter === 'articles';
    const shouldFetchForum = !filter || filter === 'all' || filter === 'forum';

    // Fetch reels (from Reel model - short-form videos)
    if (shouldFetchReels) {
      try {
        const reels = await prisma.reels.findMany({
          where: {
            authorId: userId,
            status: 'ready',
            visibility: 'public',
            publishedAt: { not: null },
          },
          orderBy: { publishedAt: 'desc' },
          take: queryTake,
        });

        for (const reel of reels) {
          const item: UnifiedContentItem = {
            id: reel.id,
            contentType: 'short_video',
            entityType: 'reel',
            content: reel.caption || '',
            createdAt: reel.publishedAt!,
            updatedAt: reel.updatedAt,
            likesCount: reel.likesCount,
            commentsCount: reel.commentsCount,
            viewsCount: reel.viewsCount,
            title: reel.title || undefined,
            images: reel.thumbnailUrl ? [reel.thumbnailUrl] : undefined,
            videoUrl: reel.videoUrl,
            videoThumbnail: reel.thumbnailUrl || undefined,
            tags: reel.hashtags?.length ? reel.hashtags : undefined,
          };
          allItems.push(item);
        }
      } catch (err) {
        console.debug('Reel model not found, skipping reels', err);
      }
    }

    // Fetch posts (if Post model exists) - exclude video type when showing reels
    if (shouldFetchPosts) {
      try {
        const postModel = (prisma as any).post;
        if (postModel) {
          const accessWhere = await buildPostVisibilityWhere(requestingUserId);
          const postTypeFilter =
            filter === 'posts'
              ? { in: ['text', 'TEXT', 'image', 'IMAGE', 'link', 'LINK', 'poll', 'POLL', 'celebration', 'CELEBRATION', 'document', 'DOCUMENT', 'mixed', 'MIXED'] }
              : filter === 'videos'
                ? { in: ['video', 'VIDEO'] }
                : { in: ['text', 'TEXT', 'image', 'IMAGE', 'video', 'VIDEO', 'link', 'LINK', 'poll', 'POLL', 'celebration', 'CELEBRATION', 'document', 'DOCUMENT', 'mixed', 'MIXED'] };

          const posts = await postModel.findMany({
            where: {
              AND: [
                {
                  OR: [
                    { authorId: userId },
                    {
                      collaborators: {
                        some: {
                          userId,
                          status: 'accepted',
                        },
                      },
                    },
                  ],
                },
                {
                  isActive: true,
                  type: postTypeFilter,
                },
                accessWhere,
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: queryTake,
          });

          for (const post of posts) {
            const contentType = post.type?.toLowerCase() === 'video' ? 'short_video' : 'post';
            allItems.push(formatUnifiedItem(post, contentType));
          }
        }
      } catch (err) {
        console.debug('Post model not found, skipping posts');
      }
    }

    // Fetch articles (if Post model exists with ARTICLE type)
    if (shouldFetchArticles) {
      try {
        const postModel = (prisma as any).post;
        if (postModel) {
          const accessWhere = await buildPostVisibilityWhere(requestingUserId);
          const articles = await postModel.findMany({
            where: {
              AND: [
                {
                  OR: [
                    { authorId: userId },
                    {
                      collaborators: {
                        some: {
                          userId,
                          status: 'accepted',
                        },
                      },
                    },
                  ],
                },
                {
                  isActive: true,
                  type: { in: ['article', 'ARTICLE'] },
                },
                accessWhere,
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: queryTake,
          });

          for (const article of articles) {
            allItems.push(formatUnifiedItem(article, 'article'));
          }
        }
      } catch (err) {
        console.debug('Article model not found, skipping articles');
      }
    }

    // Fetch forum questions (if ForumQuestion model exists)
    if (shouldFetchForum) {
      try {
        const forumQuestionModel = (prisma as any).forumQuestion;
        if (forumQuestionModel) {
          const questions = await forumQuestionModel.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: queryTake,
          });

          for (const question of questions) {
            allItems.push(formatUnifiedItem(question, 'forum_question'));
          }
        }
      } catch (err) {
        console.debug('ForumQuestion model not found, skipping forum questions');
      }

      // Fetch forum answers (if Answer model exists)
      try {
        const answerModel = (prisma as any).answer;
        if (answerModel) {
          const answers = await answerModel.findMany({
            where: { userId },
            include: {
              question: {
                select: {
                  id: true,
                  title: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
            take: queryTake,
          });

          for (const answer of answers) {
            allItems.push(formatUnifiedItem(answer, 'forum_answer'));
          }
        }
      } catch (err) {
        console.debug('Answer model not found, skipping forum answers');
      }
    }

    // Sort all items by createdAt DESC
    allItems.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Calculate total count
    const totalCount = allItems.length;

    // Paginate
    const paginatedItems = allItems.slice(skip, skip + limit);
    const hasMore = skip + limit < totalCount;

    const response = {
      items: paginatedItems,
      totalCount,
      hasMore,
    };
    if (page === 1) {
      await cacheService.set(cacheKey, response, 15, [`user:${userId}`, `feed:${userId}`]);
    }
    return response;
  } catch (error) {
    console.error(`Failed to get unified feed for user ${userId}:`, error);
    return {
      items: [],
      totalCount: 0,
      hasMore: false,
    };
  }
}
