import { getFeedConfig, buildPersonalizedFeed } from "../../../discovery/services/feed/index";
import { getRecommendationSessionPage, createRecommendationSession } from "../../../discovery/services/recommendation-platform.service";
import { selectHomeRecommendationModules } from "../../../discovery/services/home-recommendation.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { FeedV2RequestContext, isRecommendationSessionCursor, hydrateFeedV2Page, selectHomeFeedAdPlacements, shouldBypassHomeFeedCache, buildFeedDebugPayload, feedSnapshotCacheTags } from "./feed-context.controller";
import { feedDebugRequested, moduleContextFromViewer, feedV2CacheKey } from "./support.controller";

export /**
 * Serves one page of the personalized feed.
 *
 * Returns false when it declines the request (cursor belongs to another ranker,
 * pipeline produced nothing) so the caller can fall through to the legacy path
 * rather than serving an empty or unauthorised feed.
 */
async function serveHomeFeedV2(context: FeedV2RequestContext): Promise<boolean> {
  const { currentUserId, cursor, limit, blockedUserIds } = context;
  const config = getFeedConfig();

  // ---- Paging: resolve against the session the cursor was minted from -----
  // Ordering is fixed when the session is created, so page 2 can never
  // duplicate or skip a post the way re-ranking per page did.
  if (cursor) {
    if (!isRecommendationSessionCursor(cursor)) return false;

    const sessionPage = await getRecommendationSessionPage({
      cursor,
      userId: currentUserId,
      surface: 'HOME',
      pageSize: limit,
    });

    // An expired or tampered cursor ends the scroll cleanly. Re-ranking from
    // scratch here would repeat posts the viewer already scrolled past.
    if (!sessionPage) {
      context.res.json({
        posts: [],
        nextCursor: null,
        hasMore: false,
        modulePlacements: [],
        adPlacements: [],
        rankingVersion: config.rankingVersion,
      });
      return true;
    }

    const posts = await hydrateFeedV2Page(currentUserId, sessionPage.items, blockedUserIds);
    context.res.setHeader('X-Vormex-Feed-Ranker', config.rankingVersion);
    context.res.json({
      posts,
      ...sessionPage.envelope,
      feedSessionId: sessionPage.snapshot.id,
      rankingVersion: config.rankingVersion,
      hasMore: Boolean(sessionPage.envelope.nextCursor),
      modulePlacements: [],
      adPlacements: await selectHomeFeedAdPlacements(
        currentUserId,
        posts.length,
        context.adItemOffset,
        sessionPage.snapshot.id
      ),
    });
    return true;
  }

  // ---- First page: rank, snapshot, serve ---------------------------------
  const wantsDebug = feedDebugRequested(context.req);
  // Debug always re-ranks: the explain payload describes a specific ranking run
  // and is deliberately not stored in the shared cache.
  const bypassCache = wantsDebug || shouldBypassHomeFeedCache(context.req);

  /**
   * Ranks, then immediately snapshots the result into a recommendation session.
   *
   * The session is created here rather than per request so that a cache hit
   * reuses the same session id and cursor — a reload inside the cache window
   * resolves to the same ranked list, and one session row is written per actual
   * re-rank instead of per feed open.
   */
  const compute = async () => {
    const ranked = await buildPersonalizedFeed({
      userId: currentUserId,
      nowMs: context.requestStartedAtMs,
      sessionSize: config.pagination.sessionSize,
      config,
    });
    if (!ranked.items.length) return null;

    const modulePlacements = await selectHomeRecommendationModules({
      userId: currentUserId,
      organicItemCount: ranked.items.length,
      blockedAuthorIds: blockedUserIds,
      recommendationContext: moduleContextFromViewer(ranked.viewer),
    }).catch(() => []);

    const session = await createRecommendationSession({
      userId: currentUserId,
      surface: 'HOME',
      orderedItems: ranked.items.map((item) => ({
        entityType: 'POST' as const,
        entityId: item.postId,
        position: item.position,
        authorId: item.authorId,
        reasonCode: item.reasonCode,
        reasonText: item.reasonText,
        source: item.primarySource,
        // Feature values are stored for offline evaluation only; they are never
        // serialised back to a client.
        features: {
          relationship: item.signals.relationshipStrength,
          freshness: item.signals.freshness,
          quality: item.signals.engagementQuality,
          velocity: item.signals.engagementVelocity,
          contentAffinity: item.signals.contentAffinity,
          creatorAffinity: item.signals.creatorAffinity,
          finalScore: item.finalScore,
        },
      })),
      modulePlacements,
      pageSize: limit,
      snapshotAt: new Date(context.requestStartedAtMs),
      rankerVersion: config.rankingVersion,
      experimentVariant: context.experimentVariant,
      ttlMs: config.pagination.sessionTtlMs,
    });

    // Only what serving needs is cached — never the full signal vectors.
    return {
      sessionId: session.snapshot.id,
      envelope: session.envelope,
      items: session.items,
      modulePlacements,
      debug: wantsDebug ? buildFeedDebugPayload(ranked, limit) : null,
    };
  };

  /*
   * An explicit refresh (web sends x-vormex-feed-refresh on every feed open,
   * Android sends cacheBust) always re-ranks, which is what makes newly reported
   * impressions change the next feed instead of replaying a snapshot.
   */
  const snapshot = bypassCache
    ? await compute()
    : await cacheService.getOrSet(feedV2CacheKey(currentUserId, limit), compute, {
        ttlSeconds: config.pagination.candidateCacheTtlSeconds,
        tags: feedSnapshotCacheTags(`feed:${currentUserId}`),
        lockTtlMs: 30_000,
      });

  if (!snapshot?.items?.length) return false;

  const posts = await hydrateFeedV2Page(currentUserId, snapshot.items, blockedUserIds);

  context.res.setHeader('X-Vormex-Feed-Ranker', config.rankingVersion);
  context.res.setHeader('X-Vormex-Cache', bypassCache ? 'BYPASS' : 'SNAPSHOT');
  context.res.json({
    posts,
    ...snapshot.envelope,
    feedSessionId: snapshot.sessionId,
    rankingVersion: config.rankingVersion,
    hasMore: Boolean(snapshot.envelope.nextCursor),
    modulePlacements: snapshot.modulePlacements,
    adPlacements: await selectHomeFeedAdPlacements(
      currentUserId,
      posts.length,
      context.adItemOffset,
      snapshot.sessionId
    ),
    ...(wantsDebug && snapshot.debug ? { debug: snapshot.debug } : {}),
  });
  return true;
}
