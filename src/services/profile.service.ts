import { prisma } from '../config/prisma';
import { cacheService } from './cache.service';
import { requestWithBreaker } from '../utils/http-client-with-breaker.util';
import { isUUID } from '../utils/username.util';
import { decryptToken } from '../utils/encryption.util';
import { enqueueProfileViewAnalytics } from './profile-view-analytics.service';
import type {
  UnifiedContentItem,
  UnifiedFeedResponse,
  CoreProfileResponse,
  FullProfileResponse,
  ProfileConnectionStatus,
} from '../types/profile.types';
import { getActivityHeatmap } from './activity.service';
import { getGitHubContributionCalendar } from './github.service';
import { socialProofService } from './social-proof.service';
import { calculateLevelProgress } from './progress.service';
import { getPremiumAccessSnapshot } from './premium-access.service';
import { buildProfileCustomizationResponseFields } from './user-response.service';
import { bunnyStorageService } from './bunny-storage.service';
import { imageProcessingService } from './image-processing.service';
import {
  extractDomain,
  getPostMetadata,
  mapPollOptionsForResponse,
  mapPostTypeToFrontend,
  normalizeUrl,
} from '../utils/post.util';
import { buildPostVisibilityWhere } from '../utils/access-control.util';
import { serializeCoarseLocation } from '../utils/location-dto.util';

const PROFILE_ONLINE_WINDOW_MS = 5 * 60 * 1000;
const LEGACY_PROFILE_AVIF_PATTERN = /\/profiles\/avatars\/[^?#]+\.avif(?:$|[?#])/i;
const PROFILE_CORE_CACHE_TTL_SECONDS = 120;
const PROFILE_BUNDLE_CACHE_TTL_SECONDS = 120;

const CORE_PROFILE_USER_SELECT = {
  id: true,
  username: true,
  name: true,
  email: true,
  profileImage: true,
  bannerImageUrl: true,
  headline: true,
  bio: true,
  location: true,
  currentCity: true,
  currentState: true,
  currentCountry: true,
  shareLocationPublic: true,
  college: true,
  degree: true,
  branch: true,
  currentYear: true,
  graduationYear: true,
  portfolioUrl: true,
  linkedinUrl: true,
  githubProfileUrl: true,
  otherSocialUrls: true,
  isOpenToOpportunities: true,
  isOnline: true,
  lastActiveAt: true,
  isVerified: true,
  interests: true,
  createdAt: true,
} as const;

function isLegacyProfileAvifUrl(url: string | null | undefined): url is string {
  return Boolean(url && LEGACY_PROFILE_AVIF_PATTERN.test(url));
}

async function migrateLegacyProfileAvatarToWebp(
  userId: string,
  profileImage: string | null
): Promise<string | null> {
  if (!isLegacyProfileAvifUrl(profileImage)) {
    return profileImage;
  }

  try {
    const response = await requestWithBreaker<ArrayBuffer>('profile_image', 'fetch_legacy_avatar', {
      method: 'GET',
      url: profileImage,
      responseType: 'arraybuffer',
      timeout: 8_000,
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 8_000 });
    const sourceBuffer = Buffer.from(response.data);
    const webpBuffer = await imageProcessingService.processProfileAvatarWebp(sourceBuffer);
    const webpUrl = await bunnyStorageService.uploadProfilePicture(webpBuffer, userId);

    await prisma.user.update({
      where: { id: userId },
      data: { profileImage: webpUrl },
      select: { id: true },
    });
    await cacheService.invalidateTags(`user:${userId}`);

    void bunnyStorageService.deleteFile(profileImage).catch((error) => {
      console.warn(
        `Failed to delete legacy AVIF avatar for ${userId}:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
    });

    return webpUrl;
  } catch (error) {
    console.warn(
      `Failed to migrate legacy AVIF avatar for ${userId}:`,
      error instanceof Error ? error.message : 'Unknown error'
    );
    return profileImage;
  }
}

function isProfileUserOnline(user: { isOnline?: boolean | null; lastActiveAt?: Date | null }): boolean {
  if (user.isOnline) return true;
  if (!user.lastActiveAt) return false;
  return Date.now() - user.lastActiveAt.getTime() < PROFILE_ONLINE_WINDOW_MS;
}

export function normalizeProfileCacheIdentifier(value: string): string {
  const withoutPrefix = value.startsWith('@') ? value.substring(1) : value;
  return withoutPrefix.trim().toLowerCase();
}

export function profileResponseCacheKey(
  kind: 'core' | 'bundle',
  requestingUserId: string | null,
  identifier: string
): string {
  return `profile:${kind}:${requestingUserId || 'anon'}:${normalizeProfileCacheIdentifier(identifier)}`;
}

function trackProfileViewLater(
  requestingUserId: string | null,
  targetUserId: string
): void {
  if (!requestingUserId || requestingUserId === targetUserId) {
    return;
  }

  setImmediate(() => {
    void enqueueProfileViewAnalytics(
      requestingUserId,
      targetUserId,
      'profile_open'
    );
  });
}

function emptyProfileStats() {
  return {
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
}

interface ProfileRelationshipRow {
  connectionId: string | null;
  requesterId: string | null;
  status: string | null;
  isFollowing: boolean;
  isFollowedBy: boolean;
}

function toProfileConnectionState(
  relationship: ProfileRelationshipRow | null,
  requestingUserId: string | null
): CoreProfileResponse['viewerContext'] {
  const isFollowing = relationship?.isFollowing === true;
  const isFollowedBy = relationship?.isFollowedBy === true;

  if (!relationship?.connectionId || !requestingUserId) {
    return {
      connectionStatus: 'none',
      connectionId: null,
      isFollowing,
      isFollowedBy,
    };
  }

  let connectionStatus: ProfileConnectionStatus = 'none';
  let direction: 'sent' | 'received' | undefined;
  if (relationship.status === 'accepted') {
    connectionStatus = 'connected';
  } else if (relationship.status === 'blocked') {
    connectionStatus = 'blocked';
  } else if (relationship.status === 'pending') {
    direction = relationship.requesterId === requestingUserId ? 'sent' : 'received';
    connectionStatus = direction === 'sent' ? 'pending_sent' : 'pending_received';
  }

  return {
    connectionStatus,
    connectionId: relationship.connectionId,
    isFollowing,
    isFollowedBy,
    ...(direction ? { direction } : {}),
  };
}

async function backfillGitHubContributionCalendar(
  user: {
    githubConnected?: boolean | null;
    githubAccessToken?: string | null;
    githubUsername?: string | null;
  },
  targetUserId: string
): Promise<void> {
  if (!user.githubConnected || !user.githubAccessToken || !user.githubUsername) {
    return;
  }

  const accessToken = decryptToken(user.githubAccessToken);
  const contributionCalendar = await getGitHubContributionCalendar(
    user.githubUsername,
    accessToken
  );
  await prisma.gitHubStats.update({
    where: { userId: targetUserId },
    data: { contributionData: contributionCalendar as any },
  });
  await cacheService.invalidateTags(`user:${targetUserId}`);
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
    baseItem.defaultVideoId = metadata.defaultVideoId || undefined;
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

/**
 * Load the default profile header/counts path with one identity query followed
 * by bounded aggregate, connection, and follow-state branches.
 */
export async function getCoreProfile(
  requestingUserId: string | null,
  targetUsernameOrId: string
): Promise<CoreProfileResponse> {
  const identifier = normalizeProfileCacheIdentifier(targetUsernameOrId);
  const requestedCacheKey = profileResponseCacheKey(
    'core',
    requestingUserId,
    identifier
  );
  const requestedCached = await cacheService.get<CoreProfileResponse>(requestedCacheKey);
  if (requestedCached) {
    trackProfileViewLater(requestingUserId, requestedCached.user.id);
    return requestedCached;
  }

  const coordinated = await cacheService.getOrSet(
    requestedCacheKey,
    async () => {
      const user = await prisma.user.findFirst({
        where: isUUID(identifier)
          ? { id: identifier }
          : { username: identifier.toLowerCase() },
        select: CORE_PROFILE_USER_SELECT,
      });
      if (!user) {
        throw new Error('User not found');
      }

      const targetUserId = user.id;
      const isOwner = requestingUserId !== null && requestingUserId === targetUserId;
      const canonicalCacheKey = profileResponseCacheKey('core', requestingUserId, targetUserId);
      const cached = requestedCacheKey === canonicalCacheKey
        ? null
        : await cacheService.get<CoreProfileResponse>(canonicalCacheKey);
      if (cached) {
        await cacheService.set(
          requestedCacheKey,
          cached,
          PROFILE_CORE_CACHE_TTL_SECONDS,
          [`user:${targetUserId}`]
        );
        return cached;
      }

      // These bounded relationship branches replace two extra authenticated
      // client requests after the profile header has already loaded.
      const [userStats, relationship] = await Promise.all([
        prisma.userStats.findUnique({ where: { userId: targetUserId } }).catch(() => null),
        requestingUserId && !isOwner
          ? prisma.$queryRaw<ProfileRelationshipRow[]>`
              SELECT
                relationship.id AS "connectionId",
                relationship."requesterId" AS "requesterId",
                relationship.status AS "status",
                EXISTS (
                  SELECT 1
                  FROM follows forward_follow
                  WHERE forward_follow."followerId" = ${requestingUserId}
                    AND forward_follow."followingId" = ${targetUserId}
                ) AS "isFollowing",
                EXISTS (
                  SELECT 1
                  FROM follows reverse_follow
                  WHERE reverse_follow."followerId" = ${targetUserId}
                    AND reverse_follow."followingId" = ${requestingUserId}
                ) AS "isFollowedBy"
              FROM (SELECT 1) seed
              LEFT JOIN LATERAL (
                SELECT connection.id, connection."requesterId", connection.status
                FROM connections connection
                WHERE (
                  connection."requesterId" = ${requestingUserId}
                  AND connection."addresseeId" = ${targetUserId}
                ) OR (
                  connection."requesterId" = ${targetUserId}
                  AND connection."addresseeId" = ${requestingUserId}
                )
                LIMIT 1
              ) relationship ON TRUE
            `.then((rows) => rows[0] || null).catch(() => null)
          : Promise.resolve(null),
      ]);

  const sourceStats = userStats || emptyProfileStats();
  const levelProgress = calculateLevelProgress(sourceStats.xp);
  const canShowLocation = isOwner || user.shareLocationPublic === true;
  const response: CoreProfileResponse = {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      ...(isOwner ? { email: user.email } : {}),
      avatar: user.profileImage,
      profileImage: user.profileImage,
      bannerImageUrl: user.bannerImageUrl,
      headline: user.headline,
      bio: user.bio,
      location: canShowLocation ? serializeCoarseLocation(user) : null,
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
      isVerified: user.isVerified,
      interests: user.interests || [],
      createdAt: user.createdAt,
    },
    stats: {
      xp: sourceStats.xp,
      level: levelProgress.level,
      xpToNextLevel: levelProgress.xpToNextLevel,
      totalPosts: sourceStats.totalPosts,
      totalArticles: sourceStats.totalArticles,
      totalShortVideos: sourceStats.totalShortVideos,
      totalForumQuestions: sourceStats.totalForumQuestions,
      totalForumAnswers: sourceStats.totalForumAnswers,
      totalComments: sourceStats.totalComments,
      totalLikesReceived: sourceStats.totalLikesReceived,
      connectionsCount: sourceStats.connectionsCount,
      followersCount: sourceStats.followersCount,
      currentStreak: sourceStats.currentStreak,
      longestStreak: sourceStats.longestStreak,
      lastActiveDate: sourceStats.lastActiveDate,
      totalActiveDays: sourceStats.totalActiveDays,
    },
        viewerContext: toProfileConnectionState(
          relationship,
          requestingUserId
        ),
  };

  const cacheKeys = Array.from(new Set([
    requestedCacheKey,
    canonicalCacheKey,
    profileResponseCacheKey('core', requestingUserId, user.username),
  ]));
  await Promise.all(
    cacheKeys.map((cacheKey) =>
      cacheService.set(
        cacheKey,
        response,
        PROFILE_CORE_CACHE_TTL_SECONDS,
        [`user:${targetUserId}`]
      )
    )
  );
      return response;
    },
    {
      ttlSeconds: PROFILE_CORE_CACHE_TTL_SECONDS,
      lockTtlMs: 5_000,
    }
  );
  trackProfileViewLater(requestingUserId, coordinated.user.id);
  return coordinated;
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
    const identifier = normalizeProfileCacheIdentifier(targetUsernameOrId);
    const requestedCacheKey = profileResponseCacheKey(
      'bundle',
      requestingUserId,
      identifier
    );
    const requestedCached = await cacheService.get<FullProfileResponse>(requestedCacheKey);
    if (requestedCached && !isLegacyProfileAvifUrl(requestedCached.user.avatar)) {
      trackProfileViewLater(requestingUserId, requestedCached.user.id);
      return requestedCached;
    }
    if (requestedCached) {
      await cacheService.del(requestedCacheKey);
    }

    const coordinated = await cacheService.getOrSet(
      requestedCacheKey,
      async () => {
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

        const canonicalCacheKey = profileResponseCacheKey('bundle', requestingUserId, targetUserId);
        const cached = requestedCacheKey === canonicalCacheKey
          ? null
          : await cacheService.get<FullProfileResponse>(canonicalCacheKey);
        if (cached && !isLegacyProfileAvifUrl(cached.user.avatar)) {
          await cacheService.set(
            requestedCacheKey,
            cached,
            PROFILE_BUNDLE_CACHE_TTL_SECONDS,
            [`user:${targetUserId}`]
          );
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
      premiumSnapshot,
      isProfileSaved,
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
      getUnifiedContentFeed(targetUserId, 1, 20, 'all', requestingUserId).catch(() => ({
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

      getPremiumAccessSnapshot(targetUserId).catch(() => ({
        isPremium: false,
      })),

      requestingUserId && !isOwner
        ? socialProofService.isProfileSaved(requestingUserId, targetUserId).catch(() => false)
        : Promise.resolve(false),
    ]);

    // Social counters are maintained transactionally on their write paths. Recounting
    // posts, follows, and connections here adds three pool competitors per profile open.
    const stats = userStats ? { ...userStats } : {
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
      void backfillGitHubContributionCalendar(user, targetUserId).catch((error) => {
        console.warn(
          `Failed to backfill GitHub contribution calendar for ${targetUserId}:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
      });
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

    const canAccessProfileCustomization = Boolean(
      (premiumSnapshot as any).canAccessProfileCustomization
    );
    const customizationFields = buildProfileCustomizationResponseFields(
      user,
      canAccessProfileCustomization
    );
    const profileImageForResponse = await migrateLegacyProfileAvatarToWebp(
      targetUserId,
      user.profileImage
    );
    const canShowLocation = isOwner || user.shareLocationPublic === true;
    const location = canShowLocation ? serializeCoarseLocation(user) : null;

    // Build user object (exclude sensitive fields)
    const userResponse = {
      id: user.id,
      username: user.username, // Username is required
      name: user.name,
      ...(isOwner && { email: user.email }), // Only include email if owner
      avatar: profileImageForResponse,
      profileImage: profileImageForResponse,
      bannerImageUrl: user.bannerImageUrl,
      headline: user.headline,
      bio: user.bio,
      location,
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
      isVerified: user.isVerified,
      profileBadgeStyle: customizationFields.profileBadgeStyle,
      isPremium: Boolean((premiumSnapshot as any).isPremium),
      canAccessProfileCustomization,
      profileRing: customizationFields.profileRing,
      visitLoaderGiftId: customizationFields.visitLoaderGiftId,
      profileTheme: customizationFields.profileTheme,
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
      viewerContext: {
        isProfileSaved: Boolean(isProfileSaved),
      },
    };
    const cacheKeys = Array.from(new Set([
      requestedCacheKey,
      canonicalCacheKey,
      profileResponseCacheKey('bundle', requestingUserId, user.username),
    ]));
    await Promise.all(
      cacheKeys.map((cacheKey) =>
        cacheService.set(
          cacheKey,
          response,
          PROFILE_BUNDLE_CACHE_TTL_SECONDS,
          [`user:${targetUserId}`]
        )
      )
    );
        return response;
      },
      {
        ttlSeconds: PROFILE_BUNDLE_CACHE_TTL_SECONDS,
        lockTtlMs: 15_000,
      }
    );
    trackProfileViewLater(requestingUserId, coordinated.user.id);
    return coordinated;
  } catch (error) {
    console.error(
      `Failed to get full profile for ${targetUsernameOrId}:`,
      error
    );
    throw error;
  }
}
