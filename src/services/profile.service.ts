import { prisma } from '../config/prisma';
import { cacheService } from './cache.service';
import { isUUID } from '../utils/username.util';
import { decryptToken } from '../utils/encryption.util';
import type {
  UnifiedContentItem,
  UnifiedFeedResponse,
  FullProfileResponse,
} from '../types/profile.types';
import { getActivityHeatmap } from './activity.service';
import { getGitHubContributionCalendar } from './github.service';
import { socialProofService } from './social-proof.service';
import { calculateLevelProgress } from './progress.service';
import {
  extractDomain,
  getPostMetadata,
  mapPollOptionsForResponse,
  mapPostTypeToFrontend,
  normalizeUrl,
} from '../utils/post.util';

const PROFILE_ONLINE_WINDOW_MS = 5 * 60 * 1000;

function isProfileUserOnline(user: { isOnline?: boolean | null; lastActiveAt?: Date | null }): boolean {
  if (user.isOnline) return true;
  if (!user.lastActiveAt) return false;
  return Date.now() - user.lastActiveAt.getTime() < PROFILE_ONLINE_WINDOW_MS;
}

/**
 * Format database item to UnifiedContentItem
 * 
 * @param item - Database item from any content table
 * @param contentType - Type of content
 * @returns Formatted UnifiedContentItem
 */
function celebrationTypeLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  const map: Record<string, string> = {
    NEW_JOB: 'a new role',
    PROMOTION: 'a promotion',
    GRADUATION: 'graduation',
    CERTIFICATION: 'a new certification',
    WORK_ANNIVERSARY: 'a work anniversary',
    BIRTHDAY: 'a birthday',
  };
  return map[raw] || raw.replace(/_/g, ' ').toLowerCase();
}

function formatUnifiedItem(item: any, contentType: string): UnifiedContentItem {
  const baseItem: UnifiedContentItem = {
    id: item.id,
    contentType: contentType as any,
    content: item.content || item.body || item.description || '',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt,
  };

  if (contentType === 'forum_question' || contentType === 'forum_answer') {
    baseItem.entityType = contentType;
  }

  // Add title for articles and forum questions
  if (contentType === 'article' || contentType === 'forum_question') {
    baseItem.title = item.title;
  }

  // Add engagement metrics if available
  if (item.likesCount !== undefined) {
    baseItem.likesCount = item.likesCount;
  }
  if (item.commentsCount !== undefined) {
    baseItem.commentsCount = item.commentsCount;
  }
  if (item.viewsCount !== undefined) {
    baseItem.viewsCount = item.viewsCount;
  }

  // For forum answers, add question reference
  if (contentType === 'forum_answer' && item.question) {
    baseItem.questionId = item.question.id;
    baseItem.questionTitle = item.question.title;
  }

  // Add images and tags for posts/articles if available
  if (item.images) {
    baseItem.images = Array.isArray(item.images) ? item.images : [item.images];
  } else if (item.mediaUrls && item.mediaUrls.length > 0) {
    // Support for Post model which uses mediaUrls instead of images
    baseItem.images = item.mediaUrls;
    baseItem.mediaUrls = item.mediaUrls;
  }
  if (item.tags) {
    baseItem.tags = Array.isArray(item.tags) ? item.tags : [item.tags];
  }

  // Preserve rich Post metadata so Android profile/activity cards can render
  // poll/link/video content instead of flattening everything into plain text.
  if (typeof item.type === 'string') {
    const metadata = getPostMetadata(item.metadata);
    const mediaUrls = Array.isArray(item.mediaUrls) ? item.mediaUrls.filter(Boolean) : [];
    const postType = mapPostTypeToFrontend(item.type);

    baseItem.entityType = 'post';
    baseItem.postType = postType;
    if (mediaUrls.length > 0) {
      baseItem.mediaUrls = mediaUrls;
      baseItem.images = baseItem.images || mediaUrls;
    }

    const videoUrl = metadata.videoUrl || (postType === 'VIDEO' && mediaUrls.length > 0 ? mediaUrls[0] : null);
    const videoThumbnail =
      metadata.videoThumbnail || (postType === 'VIDEO' && mediaUrls.length > 0 ? mediaUrls[0] : null);
    const linkUrl = metadata.linkUrl || null;

    baseItem.videoUrl = videoUrl || undefined;
    baseItem.videoThumbnail = videoThumbnail || undefined;
    baseItem.linkUrl = linkUrl || undefined;
    baseItem.linkTitle = metadata.linkTitle || metadata.linkDomain || undefined;
    baseItem.linkDescription = metadata.linkDescription || undefined;
    baseItem.linkDomain = metadata.linkDomain || extractDomain(linkUrl) || undefined;
    baseItem.pollOptions = metadata.pollOptions?.length
      ? mapPollOptionsForResponse(metadata.pollOptions, null)
      : undefined;
    baseItem.pollEndsAt = metadata.pollEndsAt || undefined;
    baseItem.userVotedOptionId = null;
    baseItem.showResultsBeforeVote = metadata.showResultsBeforeVote || false;

    if (postType === 'ARTICLE' && metadata.articleTitle) {
      baseItem.title = metadata.articleTitle;
    }

    if (postType === 'CELEBRATION') {
      const celebrationGifUrl = normalizeUrl(metadata.celebrationGifUrl);
      baseItem.celebrationType = metadata.celebrationType ?? null;
      baseItem.celebrationGifUrl = celebrationGifUrl || null;
      baseItem.celebrationBadge = metadata.celebrationBadge ?? null;
      if (celebrationGifUrl && (!baseItem.mediaUrls || baseItem.mediaUrls.length === 0)) {
        baseItem.mediaUrls = [celebrationGifUrl];
        baseItem.images = baseItem.images || [celebrationGifUrl];
      }
      const label = celebrationTypeLabel(metadata.celebrationType);
      const trimmed = (baseItem.content || '').trim();
      if (!trimmed) {
        baseItem.content = label ? `Celebrating ${label}` : 'Celebration post';
      }
      if (!baseItem.title) {
        baseItem.title = label ? `Celebration · ${label}` : 'Celebration';
      }
    }

    return baseItem;
  }

  // Reels are also shown in the unified activity feed and need safe routing.
  if (contentType === 'short_video' && item.videoUrl) {
    baseItem.entityType = 'reel';
    baseItem.videoUrl = item.videoUrl;
    baseItem.videoThumbnail = item.thumbnailUrl || undefined;
    if (item.thumbnailUrl) {
      baseItem.images = baseItem.images || [item.thumbnailUrl];
      baseItem.mediaUrls = baseItem.mediaUrls || [item.thumbnailUrl];
    }
  }

  return baseItem;
}

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
  filter?: 'all' | 'posts' | 'articles' | 'forum' | 'videos'
): Promise<UnifiedFeedResponse> {
  try {
    const cacheKey = `profile:feed:${userId}:${filter || 'all'}:${page}:${limit}`;
    if (page === 1) {
      const cached = await cacheService.get<UnifiedFeedResponse>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const skip = (page - 1) * limit;
    const allItems: UnifiedContentItem[] = [];

    // Query different content types based on filter
    const shouldFetchPosts = !filter || filter === 'all' || filter === 'posts';
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
          take: 100,
        });

        for (const reel of reels) {
          const item: UnifiedContentItem = {
            id: reel.id,
            contentType: 'short_video',
            content: reel.caption || '',
            createdAt: reel.publishedAt!,
            updatedAt: reel.updatedAt,
            likesCount: reel.likesCount,
            commentsCount: reel.commentsCount,
            viewsCount: reel.viewsCount,
            title: reel.title || undefined,
            images: reel.thumbnailUrl ? [reel.thumbnailUrl] : undefined,
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
          const postTypeFilter =
            filter === 'posts'
              ? { in: ['text', 'image', 'link', 'poll', 'celebration', 'document', 'mixed'] }
              : { in: ['text', 'image', 'video', 'link', 'poll', 'celebration', 'document', 'mixed'] };

          const posts = await postModel.findMany({
            where: {
              authorId: userId,
              isActive: true,
              type: postTypeFilter,
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });

          for (const post of posts) {
            const contentType = post.type === 'video' ? 'short_video' : 'post';
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
          const articles = await postModel.findMany({
            where: {
              authorId: userId,
              isActive: true,
              type: 'article',
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
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
            take: 100,
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
            take: 100,
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

/**
 * Get full profile with all data (user info, stats, GitHub, activity, feed)
 * 
 * @param requestingUserId - ID of user making the request (null if anonymous)
 * @param targetUsernameOrId - Username or UUID of target user
 * @returns FullProfileResponse with all profile data
 */
export async function getFullProfile(
  requestingUserId: string | null,
  targetUsernameOrId: string
): Promise<FullProfileResponse> {
  try {
    // Remove @ prefix if present (e.g., @koushik -> koushik)
    let identifier = targetUsernameOrId;
    if (identifier.startsWith('@')) {
      identifier = identifier.substring(1);
    }

    // Find target user by UUID or username
    const user = await prisma.user.findFirst({
      where: isUUID(identifier)
        ? { id: identifier }
        : { username: identifier.toLowerCase() },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const targetUserId = user.id;
    const isOwner = requestingUserId !== null && requestingUserId === targetUserId;

    if (requestingUserId && !isOwner) {
      void socialProofService.trackProfileView(
        requestingUserId,
        targetUserId,
        'profile_open'
      );
    }

    const cacheKey = `profile:bundle:${requestingUserId || 'anon'}:${targetUserId}`;
    const cached = await cacheService.get<FullProfileResponse>(cacheKey);
    if (cached) {
      return cached;
    }

    // All profiles are public - no privacy checks needed

    // Fetch all related data in parallel
    const [
      userStats,
      githubStats,
      activityHeatmap,
      recentActivity,
      userSkills,
      experiences,
      educationHistory,
      projects,
      certificates,
      achievements,
    ] = await Promise.all([
      // UserStats
      prisma.userStats.findUnique({
        where: { userId: targetUserId },
      }).catch(() => null),

      // GitHubStats (only if connected)
      user.githubConnected
        ? prisma.gitHubStats.findUnique({
            where: { userId: targetUserId },
          }).catch(() => null)
        : Promise.resolve(null),

      // Activity heatmap (last 365 days - default view)
      getActivityHeatmap(targetUserId).catch(() => ({
        days: [],
        stats: {
          totalContributions: 0,
          currentStreak: 0,
          longestStreak: 0,
          contributionLevels: {
            level0: 0,
            level1: 0,
            level2: 0,
            level3: 0,
          },
        },
      })),

      // Recent activity feed (first 20 items)
      getUnifiedContentFeed(targetUserId, 1, 20, 'all').catch(() => ({
        items: [],
        totalCount: 0,
        hasMore: false,
      })),

      // Skills
      prisma.userSkill.findMany({
        where: { userId: targetUserId },
        include: { skill: true },
        orderBy: { createdAt: 'desc' },
      }).catch(() => []),

      // Experiences
      prisma.experience.findMany({
        where: { userId: targetUserId },
        orderBy: [
          { isCurrent: 'desc' },
          { startDate: 'desc' },
        ],
      }).catch(() => []),

      // Education
      prisma.education.findMany({
        where: { userId: targetUserId },
        orderBy: [
          { isCurrent: 'desc' },
          { startDate: 'desc' },
        ],
      }).catch(() => []),

      // Projects
      prisma.project.findMany({
        where: { userId: targetUserId },
        orderBy: [
          { featured: 'desc' },
          { startDate: 'desc' },
        ],
      }).catch(() => []),

      // Certificates
      prisma.certificate.findMany({
        where: { userId: targetUserId },
        orderBy: { issueDate: 'desc' },
      }).catch(() => []),

      // Achievements
      prisma.achievement.findMany({
        where: { userId: targetUserId },
        orderBy: { date: 'desc' },
      }).catch(() => []),
    ]);

    // Build stats object with real-time post count
    // Get actual post count from database for accuracy
    let realTimePostCount = 0;
    let realTimeArticleCount = 0;
    let realTimeShortVideoCount = 0;
    
    try {
      const postCounts = await prisma.post.groupBy({
        by: ['type'],
        where: { authorId: targetUserId },
        _count: { id: true }
      });
      
      for (const pc of postCounts) {
        const t = (pc.type || '').toLowerCase();
        if (t === 'article') {
          realTimeArticleCount += pc._count.id;
        } else if (t === 'video' || t === 'short_video') {
          realTimeShortVideoCount += pc._count.id;
        } else if (
          ['text', 'image', 'link', 'poll', 'celebration', 'document', 'mixed'].includes(t)
        ) {
          realTimePostCount += pc._count.id;
        }
      }
    } catch (err) {
      // Fallback to cached stats if count fails
      console.debug('Failed to get real-time post count, using cached', err);
    }
    
    const stats = userStats || {
      xp: 0,
      level: 1,
      totalPosts: 0,
      totalArticles: 0,
      totalShortVideos: 0,
      totalForumQuestions: 0,
      totalForumAnswers: 0,
      totalComments: 0,
      totalLikesReceived: 0,
      connectionsCount: 0,
      followersCount: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      totalActiveDays: 0,
    };
    
    // Override with real-time counts if available
    if (realTimePostCount > 0 || realTimeArticleCount > 0 || realTimeShortVideoCount > 0) {
      stats.totalPosts = realTimePostCount;
      stats.totalArticles = realTimeArticleCount;
      stats.totalShortVideos = realTimeShortVideoCount;
    }
    
    // Get real-time follower and connection counts
    try {
      const [followersCount, connectionsCount] = await Promise.all([
        prisma.follows.count({ where: { followingId: targetUserId } }),
        prisma.connections.count({ 
          where: { 
            status: 'accepted',
            OR: [
              { requesterId: targetUserId },
              { addresseeId: targetUserId }
            ]
          }
        })
      ]);
      stats.followersCount = followersCount;
      stats.connectionsCount = connectionsCount;
    } catch (err) {
      console.debug('Failed to get real-time follower/connection count', err);
    }

    const levelProgress = calculateLevelProgress(stats.xp);
    stats.level = levelProgress.level;

    let contributionCalendar = githubStats?.contributionData || null;
    if (
      user.githubConnected &&
      !contributionCalendar &&
      user.githubAccessToken &&
      user.githubUsername &&
      githubStats
    ) {
      try {
        const accessToken = decryptToken(user.githubAccessToken);
        contributionCalendar = await getGitHubContributionCalendar(
          user.githubUsername,
          accessToken
        );
        await prisma.gitHubStats.update({
          where: { userId: targetUserId },
          data: { contributionData: contributionCalendar as any },
        });
      } catch (error) {
        console.warn(
          `Failed to backfill GitHub contribution calendar for ${targetUserId}:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Build GitHub object
    const github = {
      connected: user.githubConnected || false,
      username: user.githubUsername,
      avatarUrl: user.githubAvatarUrl,
      profileUrl: user.githubProfileUrl,
      stats: githubStats
        ? {
            totalPublicRepos: githubStats.totalPublicRepos,
            totalStars: githubStats.totalStars,
            totalForks: githubStats.totalForks,
            followers: githubStats.followers,
            following: githubStats.following,
            topLanguages: githubStats.topLanguages || {},
            topRepos: githubStats.topRepos || [],
          }
        : null,
      contributionCalendar,
      lastSyncedAt: user.githubLastSyncedAt,
    };

    // Build user object (exclude sensitive fields)
    const userResponse = {
      id: user.id,
      username: user.username, // Username is required
      name: user.name,
      ...(isOwner && { email: user.email }), // Only include email if owner
      avatar: user.profileImage,
      bannerImageUrl: user.bannerImageUrl,
      headline: user.headline,
      bio: user.bio,
      location: user.location,
      college: user.college || '',
      degree: user.degree,
      branch: user.branch || '',
      currentYear: user.currentYear,
      graduationYear: user.graduationYear,
      portfolioUrl: user.portfolioUrl,
      linkedinUrl: user.linkedinUrl,
      githubProfileUrl: user.githubProfileUrl,
      otherSocialUrls: user.otherSocialUrls,
      isOpenToOpportunities: user.isOpenToOpportunities,
      isOnline: isProfileUserOnline(user),
      lastActiveAt: user.lastActiveAt,
      verified: user.isVerified,
      profileRing: user.profileRing,
      visitLoaderGiftId: user.visitLoaderGiftId,
      createdAt: user.createdAt,
    };

    // Format skills for response
    const formattedSkills = userSkills.map((us) => ({
      id: us.id,
      skill: {
        id: us.skill.id,
        name: us.skill.name,
        category: us.skill.category,
      },
      proficiency: us.proficiency,
      yearsOfExp: us.yearsOfExp,
    }));

    // Log profile view
    console.log(
      `Profile viewed: ${targetUsernameOrId} by ${requestingUserId || 'anonymous'}`
    );

    const response = {
      user: {
        ...userResponse,
        interests: user.interests || [],
      },
      stats: {
        ...stats,
        xpToNextLevel: levelProgress.xpToNextLevel,
      },
      github: github as any,
      activityHeatmap: activityHeatmap.days || [], // Extract days array for backward compatibility
      recentActivity,
      skills: formattedSkills,
      experiences,
      education: educationHistory,
      projects,
      certificates,
      achievements,
    };
    await cacheService.set(cacheKey, response, 120, [`user:${targetUserId}`]);
    return response;
  } catch (error) {
    console.error(
      `Failed to get full profile for ${targetUsernameOrId}:`,
      error
    );
    throw error;
  }
}
