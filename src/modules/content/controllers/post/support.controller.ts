
import { Request } from "express";
import { type StoredPostMetadata, getPostMetadata, parseStringArrayField, normalizeUrl, extractDomain, parseNumberField, parseBooleanField } from "../../utils/post.util";
import { parseStoredMusicAttachment } from "../../utils/music.util";
import { ensureString } from "../../../../shared/utils/request.util";
import { randomUUID } from "crypto";
import { type FinalizedDirectMedia, validateFinalizedStorageMedia } from "../../utils/direct-media-upload.util";
import { isFeedDebugAllowed, type BuildFeedOutput } from "../../../discovery/services/feed/index";
import { bunnyStorageService } from "../../../../infrastructure/media/bunny-storage.service";

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export const FEED_REALTIME_ROOM = 'feed:global';

export const RECENT_PROFILE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_RECENT_PROFILE_SIGNALS = 24;

export const postAuthorSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
  identityTrustLevel: true,
};

export const postAuthorWithProfileSignalsSelect = {
  ...postAuthorSelect,
  college: true,
  branch: true,
  degree: true,
};

export const postResponseInclude = (
  currentUserId: string,
  options: { authorProfileSignals?: boolean } = {}
) => ({
  author: {
    select: options.authorProfileSignals
      ? postAuthorWithProfileSignalsSelect
      : postAuthorSelect,
  },
  collaborators: {
    include: {
      user: {
        select: postAuthorSelect,
      },
    },
  },
  likes: {
    where: { userId: currentUserId },
    select: { userId: true, reactionType: true },
  },
  saved_posts: {
    where: { userId: currentUserId },
    select: { userId: true },
  },
  pollVotes: {
    where: { userId: currentUserId },
    select: { optionId: true, userId: true },
  },
  _count: { select: { saved_posts: true } },
});

export const feedCacheTags = (...tags: Array<string | null | undefined>): string[] => {
  const dynamicTags = tags.filter((tag): tag is string => Boolean(tag));
  return Array.from(new Set(dynamicTags));
};

export const getPostRealtimeRooms = (postId: string, visibility?: string | null): string[] => (
  String(visibility || 'public').toLowerCase() === 'public'
    ? [FEED_REALTIME_ROOM, `post:${postId}`]
    : [`post:${postId}`]
);

export function buildMetadataFromRequest(
  body: Record<string, unknown>,
  mappedType: string,
  mediaUrls: string[]
): StoredPostMetadata | null {
  const metadata: StoredPostMetadata = {};
  const mentions = parseStringArrayField(body.mentions);
  const collaboratorIds = parseStringArrayField(body.collaboratorIds);
  const music = parseStoredMusicAttachment(body.music);

  if (mentions.length > 0) {
    metadata.mentions = mentions;
  }

  if (collaboratorIds.length > 0) {
    metadata.pendingCollaboratorIds = collaboratorIds;
  }

  if (music) {
    metadata.music = music;
  }

  const defaultVideoId = ensureString(body.defaultVideoId);
  if (defaultVideoId) {
    metadata.defaultVideoId = defaultVideoId;
  }

  if (mappedType === 'video' && mediaUrls[0]) {
    metadata.videoUrl = mediaUrls[0];
  }

  if (mappedType === 'link') {
    const linkUrl = normalizeUrl(body.linkUrl);
    if (!linkUrl) {
      throw new Error('VALIDATION:Link URL is required');
    }

    metadata.linkUrl = linkUrl;
    metadata.linkTitle = ensureString(body.linkTitle) || extractDomain(linkUrl) || linkUrl;
    metadata.linkDescription = ensureString(body.linkDescription) || null;
    metadata.linkImage = normalizeUrl(body.linkImage);
    metadata.linkDomain = extractDomain(linkUrl);
  }

  if (mappedType === 'poll') {
    const optionTexts = parseStringArrayField(body.pollOptions).slice(0, 6);
    if (optionTexts.length < 2) {
      throw new Error('VALIDATION:At least 2 poll options are required');
    }

    const pollDuration = Math.max(1, parseNumberField(body.pollDuration) ?? 24);
    metadata.pollDuration = pollDuration;
    metadata.pollEndsAt = new Date(Date.now() + pollDuration * 60 * 60 * 1000).toISOString();
    metadata.showResultsBeforeVote = parseBooleanField(body.showResultsBeforeVote, false);
    metadata.pollOptions = optionTexts.map((text) => ({
      id: randomUUID(),
      text,
      votes: 0,
    }));
  }

  if (mappedType === 'article') {
    const articleTitle = ensureString(body.articleTitle);
    if (!articleTitle) {
      throw new Error('VALIDATION:Article title is required');
    }

    metadata.articleTitle = articleTitle;
    metadata.articleTags = parseStringArrayField(body.articleTags);
    metadata.articleCoverImage = mediaUrls[0] || null;
    metadata.articleReadTime = Math.max(
      1,
      Math.ceil((ensureString(body.content)?.split(/\s+/).length ?? 0) / 200)
    );
  }

  if (mappedType === 'celebration') {
    const celebrationType = ensureString(body.celebrationType);
    if (!celebrationType) {
      throw new Error('VALIDATION:Celebration type is required');
    }

    metadata.celebrationType = celebrationType;
    const celebrationBadge = ensureString(body.celebrationBadge);
    if (celebrationBadge) {
      metadata.celebrationBadge = celebrationBadge;
    }
    if (mediaUrls[0]) {
      metadata.celebrationGifUrl = mediaUrls[0];
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

export function parseDirectMediaField(value: unknown): FinalizedDirectMedia[] {
  const parsed = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return [];
        }
      })()
    : value;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is FinalizedDirectMedia => Boolean(item && typeof item === 'object'))
    .slice(0, 10);
}

export async function validateDirectPostMedia(
  userId: string,
  value: unknown
): Promise<Array<FinalizedDirectMedia & { url: string }>> {
  const media = parseDirectMediaField(value);
  const validated: Array<FinalizedDirectMedia & { url: string }> = [];

  for (const item of media) {
    if (!item.objectKey || !item.token || !item.mimeType || !Number.isFinite(Number(item.sizeBytes))) {
      throw new Error('Invalid direct media payload');
    }

    const url = await validateFinalizedStorageMedia({
      userId,
      token: String(item.token),
      objectKey: String(item.objectKey),
      mimeType: String(item.mimeType),
      sizeBytes: Number(item.sizeBytes),
      purpose: 'post_media',
    });

    validated.push({
      ...item,
      url,
      sizeBytes: Number(item.sizeBytes),
    });
  }

  return validated;
}

export function compactStringList(values: unknown[]): string[] {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

export function connectionPeerIds(
  rows: Array<{ requesterId?: string | null; addresseeId?: string | null }>,
  currentUserId: string
): string[] {
  return Array.from(
    new Set(
      rows
        .flatMap((connection) => [connection.requesterId, connection.addresseeId])
        .filter((userId): userId is string => Boolean(userId && userId !== currentUserId))
    )
  );
}

export function recentProfileWeights(
  rows: Array<{ viewedId?: string | null }>,
  currentUserId: string
): Record<string, number> {
  const uniqueViewedIds = rows
    .map((row) => String(row.viewedId || '').trim())
    .filter((viewedId) => viewedId && viewedId !== currentUserId)
    .filter((viewedId, index, all) => all.indexOf(viewedId) === index)
    .slice(0, MAX_RECENT_PROFILE_SIGNALS);

  return Object.fromEntries(
    uniqueViewedIds.map((viewedId, index) => [
      viewedId,
      Math.max(1, MAX_RECENT_PROFILE_SIGNALS - index),
    ])
  );
}

export /*
 * ---------------------------------------------------------------------------
 * feed-v2: personalized home feed
 *
 * The legacy `mode=recommended` path ranks whatever fell inside "the newest N
 * posts globally", which is the same candidate set for every viewer — so
 * reordering it could never produce a meaningfully different feed and reloading
 * showed the same posts. feed-v2 replaces that single query with a multi-pool
 * candidate stage plus a signal/rank/re-rank pipeline (src/services/feed).
 *
 * It is a strictly additive path: `HOME_FEED_V2_ENABLED=false` (or any error in
 * the pipeline) falls straight through to the code below, which is unchanged.
 * ---------------------------------------------------------------------------
 */

const FEED_V2_CACHE_VERSION = 'v1';

export function feedV2CacheKey(userId: string, limit: number): string {
  return `posts:feed:v2:${FEED_V2_CACHE_VERSION}:user:${userId}:limit:${limit}`;
}

export function feedDebugRequested(req: Request): boolean {
  if (!isFeedDebugAllowed()) return false;
  if (String(ensureString(req.query.debug) || '').toLowerCase() !== 'true' && ensureString(req.query.debug) !== '1') {
    return false;
  }
  // When a token is configured it is mandatory, so enabling debug in a
  // non-production environment still does not expose another user's affinity
  // values to anyone who guesses the query parameter.
  const requiredToken = process.env.FEED_V2_DEBUG_TOKEN;
  if (!requiredToken) return true;
  return String(req.headers['x-vormex-feed-debug'] || '') === requiredToken;
}

export /** Shapes the v2 viewer context into what `selectHomeRecommendationModules` expects. */
function moduleContextFromViewer(viewer: BuildFeedOutput['viewer']) {
  const toWeights = (tokens: string[]) =>
    Object.fromEntries(tokens.slice(0, 20).map((token) => [token, 1]));

  return {
    connectionAuthorIds: viewer.connectionIds,
    followingAuthorIds: viewer.followingIds,
    skillWeights: toWeights(viewer.skillTokens),
    interestWeights: toWeights(viewer.interestTokens),
    educationWeights: toWeights(viewer.educationTokens),
  };
}

export function collectOwnedPostMediaUrls(post: { mediaUrls?: string[] | null; metadata?: unknown }, userId: string): string[] {
  const metadata = getPostMetadata(post.metadata);
  const candidates = [
    ...(Array.isArray(post.mediaUrls) ? post.mediaUrls : []),
    metadata.videoUrl,
    metadata.videoThumbnail,
    metadata.documentUrl,
    metadata.documentThumbnail,
    metadata.articleCoverImage,
    metadata.celebrationGifUrl,
  ];

  return Array.from(new Set(
    candidates
      .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
      .filter((url) => {
        try {
          return bunnyStorageService.isUserOwnedPath(url, userId);
        } catch {
          return false;
        }
      })
  ));
}

export async function deleteOwnedPostMedia(urls: string[]): Promise<void> {
  const results = await Promise.allSettled(
    urls.map((url) => bunnyStorageService.deleteFile(url))
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn('Failed to delete post media from storage:', {
        url: urls[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}
