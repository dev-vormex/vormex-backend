import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';

/*
 * Source-text policy tests for the personalized feed.
 *
 * These cover the invariants a unit test cannot reach without a database —
 * that authorisation is re-applied at hydration, that the legacy ranker stays
 * reachable as a fallback, that debug output is gated, and that no ranking
 * constant escapes feed-config. They exist because each of these is a silent
 * failure: the feed keeps working while leaking, freezing, or drifting.
 */

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `${start} not found`);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `${end} not found after ${start}`);
  return text.slice(startIndex, endIndex);
}

test('feed-v2 is opt-outable and always falls back to the previous ranker', () => {
  const post = source('src/modules/content/controllers/post.controller.ts');
  const getFeed = between(post, 'export const getFeed', 'export const getPost');
  const pipeline = source('src/modules/discovery/services/feed/feed-pipeline.service.ts');
  const config = source('src/modules/discovery/services/feed/feed-config.ts');

  // A single, obvious kill switch rather than a JSON edit under pressure.
  assert.match(config, /envBoolean\('HOME_FEED_V2_ENABLED'/);
  assert.match(config, /envNumber\('HOME_FEED_V2_ROLLOUT_PERCENT'/);

  assert.match(getFeed, /isFeedV2Enabled\(currentUserId\)/);
  assert.match(getFeed, /serveHomeFeedV2\(/);
  // Any pipeline failure must drop through to the legacy path, never 500.
  assert.match(getFeed, /catch \(feedV2Error\)/);
  assert.match(getFeed, /if \(res\.headersSent\) return;/);

  // Bucketing must be a pure function of the user id, or a viewer flips between
  // rankers request to request and sees exactly the churn this work fixes.
  assert.match(pipeline, /export function isFeedV2Enabled/);
  assert.doesNotMatch(pipeline, /Math\.random/);
});

test('ranking never bypasses server-side authorisation', () => {
  const post = source('src/modules/content/controllers/post.controller.ts');
  const signals = source('src/modules/discovery/services/feed/feed-signals.service.ts');
  const eligibility = source('src/modules/discovery/services/feed/feed-eligibility.service.ts');
  const hydrate = between(post, 'async function hydrateFeedV2Page', 'interface FeedV2RequestContext');

  // Two independent gates: candidates are filtered by identity, and the rows
  // that actually reach ranking and the client are re-checked against the same
  // visibility rule the rest of the API uses.
  assert.match(signals, /buildPostVisibilityWhere\(input\.userId\)/);
  assert.match(hydrate, /buildPostVisibilityWhere\(currentUserId\)/);
  assert.match(hydrate, /blockedUserIds\.length > 0 \? \{ authorId: \{ notIn: blockedUserIds \} \}/);
  assert.match(hydrate, /isActive: true/);

  // Blocking overrides ranking: the block list is awaited, not defaulted away.
  assert.match(eligibility, /const blockedUserIds = await getBlockedUserIds\(userId\);/);
  assert.match(eligibility, /notInterestedPostIds/);
  assert.match(eligibility, /hiddenAuthorIds/);
});

test('non-network candidate pools are restricted to public posts', () => {
  const generators = source('src/modules/discovery/services/feed/candidate-generators.ts');

  // Only pools scoped to accepted connections may surface connections-only
  // posts. Everything else is public-only at the SQL layer.
  const network = between(generators, 'const connectionGenerator', 'const interactedCreatorGenerator');
  assert.match(network, /visibilities: NETWORK_VISIBILITIES/);

  const following = between(generators, 'const followingGenerator', 'const connectionGenerator');
  assert.match(following, /visibilities: PUBLIC_VISIBILITIES/);

  for (const generator of ['collegeGenerator', 'courseGenerator', 'interestGenerator', 'skillGenerator']) {
    const block = between(generators, `const ${generator}`, 'toRefs(rows');
    assert.match(block, /p\."visibility" IN \('public', 'PUBLIC'\)/, `${generator} must be public-only`);
  }

  // The only pool allowed to bypass the public filter is the one that surfaces
  // the viewer's own posts, and only for the viewer's own author id.
  const recent = between(generators, 'const recentGenerator', 'export const CANDIDATE_GENERATORS');
  assert.match(recent, /OR p\."authorId" = \$\{viewer\.userId\}/);
});

test('a failing candidate pool degrades the feed instead of breaking it', () => {
  const generators = source('src/modules/discovery/services/feed/candidate-generators.ts');

  assert.match(generators, /Promise\.allSettled\(/);
  assert.match(generators, /failedSources\.push\(generator\.source\)/);
  // RECENT is the guarantee that a viewer with no graph still gets a feed.
  assert.match(generators, /recentGenerator,\n\];/);
});

test('debug output is developer-only and never public', () => {
  const post = source('src/modules/content/controllers/post.controller.ts');
  const config = source('src/modules/discovery/services/feed/feed-config.ts');
  const gate = between(post, 'function feedDebugRequested', 'function moduleContextFromViewer');

  // Off by default in production, and a configured token is mandatory when set.
  assert.match(config, /envBoolean\('FEED_V2_DEBUG_ENABLED', process\.env\.NODE_ENV !== 'production'\)/);
  assert.match(gate, /if \(!isFeedDebugAllowed\(\)\) return false;/);
  assert.match(gate, /FEED_V2_DEBUG_TOKEN/);
  assert.match(gate, /x-vormex-feed-debug/);
});

test('the impression endpoint keeps accepting the shipped client payload', () => {
  const post = source('src/modules/content/controllers/post.controller.ts');
  const impressions = source('src/modules/discovery/services/feed/feed-impression.service.ts');
  const handler = between(post, 'export const recordFeedImpressions', 'const getPostRealtimeRooms');

  assert.match(handler, /normalizeImpressionPayload\(req\.body\)/);
  // Both shapes, because shipped app versions send the legacy one.
  assert.match(impressions, /Array\.isArray\(payload\.postIds\)/);
  assert.match(impressions, /Array\.isArray\(payload\.impressions\)/);
  // Served rows are not impressions; a card that flickered past is not either.
  assert.match(impressions, /entry\.visibleMs < MIN_QUALIFYING_VISIBLE_MS/);
  // Repeat views update the row rather than inserting duplicates.
  assert.match(impressions, /ON CONFLICT \("userId", "postId"\) DO UPDATE SET/);
  assert.match(impressions, /"seenCount"\s+= "feed_impressions"\."seenCount" \+ 1/);
});

test('pagination is cursor-based over a fixed ranked session', () => {
  const post = source('src/modules/content/controllers/post.controller.ts');
  const serve = between(post, 'async function serveHomeFeedV2', 'function collectOwnedPostMediaUrls');

  // Ordering is frozen when the session is created, so page 2 cannot duplicate
  // or skip a post the way per-page re-ranking did.
  assert.match(serve, /getRecommendationSessionPage\(\{/);
  assert.match(serve, /createRecommendationSession\(\{/);
  assert.doesNotMatch(serve, /skip:\s*\(/, 'offset pagination must not reappear');
  // An unresolvable cursor ends the scroll rather than replaying page 1.
  assert.match(serve, /if \(!sessionPage\) \{/);
  assert.match(serve, /hasMore: false/);

  // The session is minted inside the cached compute, so a reload within the
  // cache window reuses the same session id and cursor instead of writing a new
  // session row per feed open.
  const computeBlock = between(serve, 'const compute = async () => {', 'const snapshot = bypassCache');
  assert.match(computeBlock, /createRecommendationSession\(\{/);
  assert.match(serve, /cacheService\.getOrSet\(feedV2CacheKey\(currentUserId, limit\), compute/);

  // Debug describes one specific ranking run, so it must never be served from
  // (or written to) the shared cache.
  assert.match(serve, /const bypassCache = wantsDebug \|\| shouldBypassHomeFeedCache\(context\.req\)/);
});

test('every ranking constant lives in feed-config', () => {
  const ranker = source('src/modules/discovery/services/feed/feed-ranker.ts');
  const reranker = source('src/modules/discovery/services/feed/feed-reranker.ts');

  // Weights and penalties are only ever read from config, never inlined. A
  // stray literal here is how the previous ranker became untunable.
  for (const [name, text] of [['ranker', ranker], ['reranker', reranker]] as const) {
    const body = text.slice(text.indexOf('export function'));
    const suspicious = body.match(/[+\-*]\s*\d{2,}(?!\s*[),;])/g) || [];
    assert.deepEqual(suspicious, [], `${name} has inline ranking constants: ${suspicious.join(', ')}`);
  }

  assert.match(ranker, /const w = config\.weights;/);
  assert.match(ranker, /const p = config\.penalties;/);
  assert.match(reranker, /const d = config\.diversity;/);
});

test('the pipeline stages stay separable', () => {
  const pipeline = source('src/modules/discovery/services/feed/feed-pipeline.service.ts');

  // Each stage is a named call in order, so a stage can be swapped (heuristic
  // ranker to a learned one) without rewriting the feed.
  for (const stage of [
    'loadFeedViewerContext',
    'loadEligibilityContext',
    'generateCandidates',
    'filterEligibleCandidates',
    'loadSignalInputs',
    'computeSignals',
    'rankCandidate',
    'sortScoredCandidates',
    'rerankFeed',
  ]) {
    assert.match(pipeline, new RegExp(`\\b${stage}\\b`), `pipeline must call ${stage}`);
  }
});
