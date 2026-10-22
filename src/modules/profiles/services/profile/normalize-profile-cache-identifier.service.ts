import { prisma } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { decryptToken } from "../../../../infrastructure/security/encryption.util";
import { enqueueProfileViewAnalytics } from "../profile-view-analytics.service";
import type { UnifiedContentItem, CoreProfileResponse, ProfileConnectionStatus } from "../../types/profile.types";
import { getGitHubContributionCalendar } from "../../../../infrastructure/github/github.service";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";
import { imageProcessingService } from "../../../../infrastructure/media/image-processing.service";
import { extractDomain, getPostMetadata, mapPollOptionsForResponse, mapPostTypeToFrontend, normalizeUrl } from "../../../content/utils/post.util";

const PROFILE_ONLINE_WINDOW_MS = 5 * 60 * 1000;

const LEGACY_PROFILE_AVIF_PATTERN = /\/profiles\/avatars\/[^?#]+\.avif(?:$|[?#])/i;

export const PROFILE_CORE_CACHE_TTL_SECONDS = 120;

export const PROFILE_BUNDLE_CACHE_TTL_SECONDS = 120;

export const PROFILE_SECTIONS_CACHE_TTL_SECONDS = 5 * 60;

export const CORE_PROFILE_USER_SELECT = {
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

export function isLegacyProfileAvifUrl(url: string | null | undefined): url is string {
  return Boolean(url && LEGACY_PROFILE_AVIF_PATTERN.test(url));
}

export async function migrateLegacyProfileAvatarToWebp(
  userId: string,
  profileImage: string | null
): Promise<string | null> {
  if (!isLegacyProfileAvifUrl(profileImage)) {
    return profileImage;
  }

  try {
    const storagePath = bunnyStorageService.getStoragePath(profileImage);
    if (!storagePath.startsWith(`profiles/avatars/${userId}-`)) {
      return profileImage;
    }
    const sourceBuffer = await bunnyStorageService.downloadFile(storagePath, 10 * 1024 * 1024);
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

export function isProfileUserOnline(user: { isOnline?: boolean | null; lastActiveAt?: Date | null }): boolean {
  if (user.isOnline) return true;
  if (!user.lastActiveAt) return false;
  return Date.now() - user.lastActiveAt.getTime() < PROFILE_ONLINE_WINDOW_MS;
}

export function normalizeProfileCacheIdentifier(value: string): string {
  const withoutPrefix = value.startsWith('@') ? value.substring(1) : value;
  return withoutPrefix.trim().toLowerCase();
}

export function profileResponseCacheKey(
  kind: 'core' | 'bundle' | 'sections',
  requestingUserId: string | null,
  identifier: string
): string {
  return `profile:${kind}:${requestingUserId || 'anon'}:${normalizeProfileCacheIdentifier(identifier)}`;
}

export function trackProfileViewLater(
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

export function emptyProfileStats() {
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

export interface ProfileRelationshipRow {
  connectionId: string | null;
  requesterId: string | null;
  status: string | null;
  isFollowing: boolean;
  isFollowedBy: boolean;
}

export function toProfileConnectionState(
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

export async function backfillGitHubContributionCalendar(
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

export function formatUnifiedItem(item: any, contentType: string): UnifiedContentItem {
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
