import { Response } from "express";
import { ensureString } from "../../../../shared/utils/request.util";
import { assignRecommendationVariant } from "../../../discovery/services/recommendation-engine.service";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { getRecommendationPreferences, type RecommendationSnapshotItem, getRecommendationSessionPage, createRecommendationSession } from "../../../discovery/services/recommendation-platform.service";
import { decodeRecommendedFeedCursor, recommendedFeedCandidateLimit, rankFeedPage } from "../../../discovery/services/feed-algorithm.service";
import { decodeKeysetCursor, createdAtDescKeysetWhere, encodeKeysetCursor } from "../../../../shared/utils/keyset-pagination.util";
import { isFeedV2Enabled } from "../../../discovery/services/feed/index";
import { logger } from "../../../../infrastructure/logging/logger";
import { prismaRead, JOIN_RELATIONS } from "../../../../config/prisma";
import { buildPostVisibilityWhere } from "../../../../shared/utils/access-control.util";
import { attachReactionSummaries, mapPostResponse } from "../../utils/post.util";
import { getPremiumVisibilityByUserIds, applyPremiumVisibilityToUser } from "../../../premium/services/premium-visibility.service";
import { rankHomePostCandidates, selectHomeRecommendationModules } from "../../../discovery/services/home-recommendation.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { AuthRequest, postResponseInclude } from "./support.controller";
import { HOME_FEED_DEFAULT_LIMIT, HOME_FEED_MAX_LIMIT, homeFeedSnapshotWindow, shouldBypassHomeFeedCache, buildHomeFeedCacheKey, selectHomeFeedAdPlacements, buildFeedRecommendationContextForUser, FEED_IMPRESSION_LOOKBACK_MS, HOME_FEED_RECOMMENDATION_SESSION_TTL_MS, feedSnapshotCacheTags, HOME_FEED_CACHE_TTL_SECONDS } from "./feed-context.controller";
import { serveHomeFeedV2 } from "./feed-snapshot.controller";

// Get feed
export const getFeed = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const requestStartedAtMs = Date.now();
    const cursor = ensureString(req.query.cursor);
    const requestedLimit = parseInt(ensureString(req.query.limit) || String(HOME_FEED_DEFAULT_LIMIT), 10);
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? requestedLimit : HOME_FEED_DEFAULT_LIMIT, 1),
      HOME_FEED_MAX_LIMIT
    );
    const modeRaw = (ensureString(req.query.mode) || 'recommended').toLowerCase();
    const mode: 'latest' | 'recommended' = modeRaw === 'latest' ? 'latest' : 'recommended';
    const experimentVariant = assignRecommendationVariant(currentUserId);
    const snapshotWindow = homeFeedSnapshotWindow(requestStartedAtMs);
    const blockedUserIdsPromise = getBlockedUserIds(currentUserId);
    const recommendationEventsEnabled = process.env.RECOMMENDATION_EVENTS_ENABLED === 'true';
    let unifiedRankingEnabled =
      mode === 'recommended' &&
      (experimentVariant === 'treatment' || experimentVariant === 'training_exploration');
    if (unifiedRankingEnabled) {
      const preferences = await getRecommendationPreferences(currentUserId).catch(() => ({
        personalizedRecommendationsEnabled: true,
      }));
      unifiedRankingEnabled = preferences.personalizedRecommendationsEnabled;
    }
    const adSessionId = ensureString(req.query.adSessionId);
    const requestedAdItemOffset = parseInt(ensureString(req.query.adItemOffset) || '0', 10);
    const adItemOffset = Math.min(Math.max(Number.isFinite(requestedAdItemOffset) ? requestedAdItemOffset : 0, 0), 10000);
    const recommendedCursorState =
      mode === 'recommended' && !unifiedRankingEnabled
        ? decodeRecommendedFeedCursor(cursor, requestStartedAtMs)
        : null;
    const recommendationSessionStartedAtMs =
      recommendedCursorState?.sessionStartedAtMs ?? requestStartedAtMs;
    const dbCursor =
      mode === 'recommended'
        ? recommendedCursorState?.baseCursor
        : null;
    const latestCursor =
      mode === 'latest'
        ? decodeKeysetCursor(cursor, 'feed.latest')
        : null;
    const latestCursorWhere = createdAtDescKeysetWhere(latestCursor);
    const candidateLimit =
      unifiedRankingEnabled
        ? recommendedFeedCandidateLimit(limit)
        : mode === 'recommended'
        ? recommendedFeedCandidateLimit(limit)
        : limit;
    const bypassFeedCache = shouldBypassHomeFeedCache(req);
    const cacheCursor =
      mode === 'recommended'
        ? cursor
        : cursor;
    const feedCacheKey = buildHomeFeedCacheKey({
      userId: currentUserId,
      cursor: cacheCursor || '',
      limit,
      mode,
      experimentVariant,
      snapshotWindow,
    });
    const blockedUserIds = await blockedUserIdsPromise;
    const blockedUserIdSet = new Set(blockedUserIds);

    /*
     * feed-v2 runs first for recommended mode. It declines (returns false) when
     * the cursor belongs to another ranker or when it produced no items, and any
     * error inside it is swallowed here — either way the untouched legacy path
     * below still serves a correct, privacy-filtered feed.
     */
    if (mode === 'recommended' && !unifiedRankingEnabled && isFeedV2Enabled(currentUserId)) {
      try {
        const served = await serveHomeFeedV2({
          req,
          res,
          currentUserId,
          cursor: cursor || '',
          limit,
          adSessionId: adSessionId || '',
          adItemOffset,
          blockedUserIds,
          requestStartedAtMs,
          experimentVariant,
        });
        if (served) return;
      } catch (feedV2Error) {
        logger.error({
          event: 'feed.v2.failed',
          userId: currentUserId,
          error: feedV2Error instanceof Error ? feedV2Error.message : String(feedV2Error),
        });
        // If the failure happened after the page was written there is nothing
        // left to fall back to; retrying below would write a second body.
        if (res.headersSent) return;
      }
    }

    const decoratePost = (post: any, item: RecommendationSnapshotItem | undefined) => item ? {
      ...post,
      reasonCode: item.reasonCode,
      reasonText: item.reasonText,
      source: item.source,
      position: item.position,
      isBoosted: Boolean(item.isBoosted),
      socialActors: item.socialActors || [],
    } : post;

    if (unifiedRankingEnabled && cursor) {
      const sessionPage = await getRecommendationSessionPage({
        cursor,
        userId: currentUserId,
        surface: 'HOME',
        pageSize: limit,
      });
      if (!sessionPage) {
        res.status(400).json({ error: 'Invalid or expired recommendation cursor' });
        return;
      }
      const ids = sessionPage.items.map((item) => item.entityId);
      const posts = ids.length > 0 ? await prismaRead.post.findMany({
        where: {
          id: { in: ids },
          isActive: true,
          ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
          ...(await buildPostVisibilityWhere(currentUserId)),
        },
        include: postResponseInclude(currentUserId, { authorProfileSignals: true }),
        relationLoadStrategy: JOIN_RELATIONS,
      }) : [];
      const postById = new Map(posts.map((post) => [post.id, post]));
      const ordered = sessionPage.items.map((item) => postById.get(item.entityId)).filter((post): post is NonNullable<typeof post> => Boolean(post));
      await attachReactionSummaries(prismaRead as any, ordered);
      const authorVisibilityByUser = await getPremiumVisibilityByUserIds(ordered.map((post: any) => post.authorId));
      const responsePosts = sessionPage.items.flatMap((item) => {
        const post: any = postById.get(item.entityId);
        if (!post) return [];
        const withPremium = {
          ...post,
          author: post.author ? applyPremiumVisibilityToUser(post.author, authorVisibilityByUser) : post.author,
        };
        return [decoratePost(mapPostResponse(withPremium, currentUserId), item)];
      });
      res.json({
        posts: responsePosts,
        ...sessionPage.envelope,
        hasMore: Boolean(sessionPage.envelope.nextCursor),
        modulePlacements: [],
        adPlacements: await selectHomeFeedAdPlacements(currentUserId, responsePosts.length, adItemOffset, sessionPage.snapshot.id),
      });
      return;
    }

    const computeFeedPayload = async () => {
      const accessWhere = await buildPostVisibilityWhere(currentUserId);
      /*
       * buildPostVisibilityWhere returns its gate under an `AND` key. Anything
       * else that needs `AND` has to be merged into that same array — spreading
       * a second `AND` into this object literal silently overwrites the gate
       * and serves every author's connections/private posts. That is exactly
       * what the `mode === 'latest'` keyset cursor used to do, so the leak only
       * appeared from page 2 of the latest feed onward.
       */
      const accessAnd = Array.isArray(accessWhere.AND)
        ? (accessWhere.AND as Array<Record<string, unknown>>)
        : [accessWhere];

      const postsPromise = prismaRead.post.findMany({
        where: {
          isActive: true,
          ...(blockedUserIds.length > 0 ? { authorId: { notIn: blockedUserIds } } : {}),
          ...(mode === 'recommended'
            ? { createdAt: { lte: new Date(recommendationSessionStartedAtMs + 5_000) } }
            : {}),
          AND: [
            ...accessAnd,
            ...(mode === 'latest' && latestCursorWhere ? [latestCursorWhere] : []),
          ],
        },
        include: postResponseInclude(currentUserId, { authorProfileSignals: mode === 'recommended' }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: candidateLimit + 1,
        ...(dbCursor ? { cursor: { id: dbCursor }, skip: 1 } : {}),
        relationLoadStrategy: JOIN_RELATIONS,
      });

      const feedImpressionsModel = (prismaRead as any).feed_impressions;
      const recommendationContextPromise =
        mode === 'recommended'
          ? buildFeedRecommendationContextForUser(currentUserId)
          : Promise.resolve(null);

      const [posts, recommendationContext] = await Promise.all([
        postsPromise,
        recommendationContextPromise,
      ]);

      const hasMoreChronological = posts.length > candidateLimit;
      const rawChronologicalItems = hasMoreChronological ? posts.slice(0, candidateLimit) : posts;
      const authorVisibilityByUser = await getPremiumVisibilityByUserIds(
        rawChronologicalItems.map((post) => post.authorId)
      );
      const chronologicalItems = rawChronologicalItems.map((post) => ({
        ...post,
        author: post.author
          ? applyPremiumVisibilityToUser(post.author, authorVisibilityByUser)
          : post.author,
      }));

      const impressions =
        mode === 'recommended' && feedImpressionsModel && chronologicalItems.length > 0
          ? await feedImpressionsModel.findMany({
              where: {
                userId: currentUserId,
                postId: { in: chronologicalItems.map((post) => post.id) },
                seenAt: { gte: new Date(Date.now() - FEED_IMPRESSION_LOOKBACK_MS) },
              },
              select: { postId: true, seenAt: true },
            })
          : [];
      const rankingImpressions = Array.isArray(impressions)
        ? impressions.filter((item: { seenAt: Date }) => {
            const seenAtMs = new Date(item.seenAt).getTime();
            return !Number.isFinite(seenAtMs) || seenAtMs < recommendationSessionStartedAtMs;
          })
        : [];

      const seenPostIds = Array.isArray(rankingImpressions)
        ? rankingImpressions.map((item: { postId: string }) => item.postId)
        : [];
      const seenAtByPostId = Array.isArray(rankingImpressions)
        ? Object.fromEntries(
            rankingImpressions.map((item: { postId: string; seenAt: Date }) => [item.postId, item.seenAt])
          )
        : {};

      let pageItems = chronologicalItems;
      let nextCursor: string | null = null;
      let hasMore = hasMoreChronological;
      let recommendationEnvelope: any = null;
      let recommendationItems = new Map<string, RecommendationSnapshotItem>();
      let modulePlacements: any[] = [];
      if (unifiedRankingEnabled) {
        const ranked = await rankHomePostCandidates({
          userId: currentUserId,
          posts: chronologicalItems,
          recommendationContext,
          seenAtByPostId,
          nowMs: recommendationSessionStartedAtMs,
          experimentVariant,
        });
        modulePlacements = await selectHomeRecommendationModules({
          userId: currentUserId,
          organicItemCount: ranked.length,
          blockedAuthorIds: blockedUserIds,
          recommendationContext,
        });
        const session = await createRecommendationSession({
          userId: currentUserId,
          surface: 'HOME',
          orderedItems: ranked.map((item) => ({
            entityType: 'POST',
            entityId: item.id,
            position: item.position,
            authorId: item.authorId,
            reasonCode: item.reasonCode,
            reasonText: item.reasonText,
            source: item.primarySource,
            examinationPropensity: item.examinationPropensity,
            features: item.features,
            socialActors: item.socialActors,
          })),
          modulePlacements,
          pageSize: limit,
          snapshotAt: new Date(recommendationSessionStartedAtMs),
          experimentVariant,
          ttlMs: HOME_FEED_RECOMMENDATION_SESSION_TTL_MS,
        });
        recommendationEnvelope = session.envelope;
        recommendationItems = new Map(session.items.map((item) => [item.entityId, item]));
        const postById = new Map(ranked.map((item) => [item.id, item.value]));
        pageItems = session.items.map((item) => postById.get(item.entityId)).filter(Boolean);
        nextCursor = session.envelope.nextCursor;
        hasMore = Boolean(nextCursor);
      } else if (mode === 'recommended') {
        try {
          const rankedPage = rankFeedPage(chronologicalItems, {
            ...(recommendationContext || {}),
            seenPostIds,
            seenAtByPostId,
            nowMs: recommendationSessionStartedAtMs,
          }, {
            limit,
            cursorState: recommendedCursorState || undefined,
            hasMoreChronological,
            chronologicalBoundaryCursor: chronologicalItems[chronologicalItems.length - 1]?.id || null,
          });
          pageItems = rankedPage.items;
          nextCursor = rankedPage.nextCursor;
          hasMore = rankedPage.hasMore;
        } catch (rankingError) {
          console.error('Feed ranking failed, falling back to latest ordering:', rankingError);
          pageItems = chronologicalItems.slice(0, limit);
          nextCursor =
            hasMoreChronological || chronologicalItems.length > pageItems.length
              ? pageItems[pageItems.length - 1]?.id || null
              : null;
          hasMore = Boolean(nextCursor);
        }
      } else {
        pageItems = chronologicalItems.slice(0, limit);
        const lastItem = pageItems[pageItems.length - 1];
        nextCursor = hasMoreChronological && lastItem
          ? encodeKeysetCursor({ scope: 'feed.latest', id: lastItem.id, t: new Date(lastItem.createdAt).toISOString() })
          : null;
      }

      await attachReactionSummaries(prismaRead as any, pageItems);
      let mappedPosts = pageItems.map((post) => decoratePost(
        mapPostResponse(post, currentUserId),
        recommendationItems.get(String(post.id))
      ));
      if (!unifiedRankingEnabled && recommendationEventsEnabled && mappedPosts.length > 0) {
        const eventSession = await createRecommendationSession({
          userId: currentUserId,
          surface: 'HOME',
          orderedItems: mappedPosts.map((post, index) => ({
            entityType: 'POST', entityId: post.id, position: index + 1, authorId: post.authorId,
            reasonCode: 'CURRENT_RANKER', reasonText: 'Recommended for you', source: 'CURRENT_RANKER',
          })),
          pageSize: mappedPosts.length,
          experimentVariant,
          ttlMs: HOME_FEED_RECOMMENDATION_SESSION_TTL_MS,
        });
        recommendationEnvelope = { ...eventSession.envelope, nextCursor };
        const eventItems = new Map(eventSession.items.map((item) => [item.entityId, item]));
        mappedPosts = mappedPosts.map((post) => decoratePost(post, eventItems.get(post.id)));
      }

      return {
        posts: mappedPosts,
        nextCursor,
        hasMore,
        modulePlacements,
        snapshotWindow,
        ...(recommendationEnvelope || {}),
      };
    };

    const feedPayload = bypassFeedCache
      ? await computeFeedPayload()
      : await cacheService.getOrSet(feedCacheKey, computeFeedPayload, {
          tags: feedSnapshotCacheTags(`feed:${currentUserId}`),
          ttlSeconds: HOME_FEED_CACHE_TTL_SECONDS,
          lockTtlMs: 60_000,
        });
    const filteredPosts = feedPayload.posts.filter((post: { authorId?: string; author?: { id?: string } }) => {
      const authorId = post.authorId || post.author?.id;
      return !authorId || !blockedUserIdSet.has(String(authorId));
    });

    const adPlacements = await selectHomeFeedAdPlacements(
      currentUserId,
      filteredPosts.length,
      adItemOffset,
      adSessionId
    );

    const responsePayload = {
      ...feedPayload,
      posts: filteredPosts,
      adPlacements,
    };

    res.setHeader('X-Vormex-Cache', bypassFeedCache ? 'BYPASS' : 'SNAPSHOT');
    res.setHeader('X-Vormex-Feed-Window', String(snapshotWindow));
    res.json(responsePayload);

    // Returned rows are candidates, not impressions. Android viewport events are authoritative.
  } catch (error) {
    console.error('getFeed error:', error);
    // A failure after the ranked page was already streamed must not try to write
    // a second response body.
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to fetch feed' });
    }
  }
};
