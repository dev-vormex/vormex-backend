import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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

test('home feed uses a Redis-backed daily ranked snapshot and single-flight lock', () => {
  const post = source('src/controllers/post.controller.ts');
  const getFeed = between(post, 'export const getFeed', 'export const getPost');

  assert.match(post, /HOME_FEED_SNAPSHOT_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(getFeed, /cacheService\.getOrSet/);
  assert.match(getFeed, /snapshotWindow/);
  assert.match(getFeed, /lockTtlMs: 60_000/);
  assert.match(getFeed, /tags: feedSnapshotCacheTags\(`feed:\$\{currentUserId\}`\)/);
  assert.match(getFeed, /recommendedFeedCandidateLimit\(limit\)/);
  assert.doesNotMatch(getFeed, /unifiedRankingEnabled\s*\|\|\s*recommendationEventsEnabled/);
});

test('ordinary engagement does not evict every user feed snapshot', () => {
  const post = source('src/controllers/post.controller.ts');
  const tagBuilder = between(post, 'const feedCacheTags', 'async function enqueuePostCreated');
  const engagement = between(post, 'export const toggleLike', 'export const getLikes');
  const saved = source('src/controllers/saved.controller.ts');

  assert.doesNotMatch(tagBuilder.slice(0, tagBuilder.indexOf('const feedSnapshotCacheTags')), /HOME_FEED_CACHE_GLOBAL_TAG/);
  assert.match(tagBuilder, /const feedSnapshotCacheTags/);
  assert.doesNotMatch(engagement, /HOME_FEED_CACHE_GLOBAL_TAG/);
  assert.doesNotMatch(saved, /feed:global/);
});

test('browser no-cache headers do not bypass the server snapshot', () => {
  const post = source('src/controllers/post.controller.ts');
  const bypass = between(
    post,
    'function shouldBypassHomeFeedCache',
    'function writeRecommendedFeedImpressions'
  );

  assert.match(bypass, /x-vormex-feed-refresh/);
  assert.match(bypass, /cacheBust/);
  assert.doesNotMatch(bypass, /cache-control/i);
});

test('stories are Redis cached by viewer and daily window with mutation invalidation', () => {
  const stories = source('src/controllers/stories.controller.ts');
  const feed = between(stories, 'export const getStoriesFeed', 'export const createStory');

  assert.match(stories, /STORY_FEED_SNAPSHOT_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(feed, /cacheService\.getOrSet/);
  assert.match(feed, /pruneExpiredStoryGroups/);
  assert.match(stories, /invalidateStoryFeedCaches\('stories:feed:global'/);
  assert.match(stories, /`stories:\$\{viewerId\}`/);
});

test('daily and smart people matches share the 24-hour Redis snapshot contract', () => {
  const engagement = source('src/controllers/engagement.controller.ts');
  const matching = source('src/controllers/matching.controller.ts');
  const daily = between(engagement, 'export const getDailyMatches', 'export const getPeopleLikeYou');
  const smart = between(matching, 'export const getSmartMatches', 'export const getMentorMatches');

  assert.match(engagement, /DAILY_MATCH_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(daily, /cacheService\.getOrSet/);
  assert.match(daily, /matching:daily/);
  assert.match(matching, /SMART_MATCH_WINDOW_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(smart, /cacheService\.getOrSet/);
  assert.match(smart, /snapshotWindow/);
});

test('recommendation sessions and preferences can outlive a slow first request', () => {
  const recommendations = source('src/services/recommendation-platform.service.ts');

  assert.match(recommendations, /ttlMs\?: number/);
  assert.match(recommendations, /SESSION_VALIDATION_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(recommendations, /Math\.min\([\s\S]*?SESSION_VALIDATION_MS/);
  assert.match(recommendations, /recommendation:preferences:v1:user:/);
  assert.match(recommendations, /cacheService\.getOrSet/);
});
