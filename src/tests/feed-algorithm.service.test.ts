import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeedRecommendationProfile,
  calculatePostScore,
  decodeRecommendedFeedCursor,
  rankFeedPage,
  rankFeed,
  recommendedFeedCandidateLimit,
} from '../services/feed-algorithm.service';

const now = new Date('2026-05-15T10:00:00.000Z').getTime();

function post(overrides: Record<string, any> = {}) {
  const id = overrides.id || `post-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    authorId: overrides.authorId || 'author-generic',
    author: {
      id: overrides.authorId || 'author-generic',
      username: overrides.username || 'generic',
      name: overrides.authorName || 'Generic Author',
      headline: overrides.headline || '',
      college: overrides.college || null,
      branch: overrides.branch || null,
      degree: overrides.degree || null,
    },
    content: overrides.content || 'General campus update',
    createdAt: overrides.createdAt || new Date(now - 2 * 60 * 60 * 1000),
    mediaUrls: overrides.mediaUrls || [],
    metadata: overrides.metadata || null,
    type: overrides.type || 'text',
    visibility: overrides.visibility || 'public',
    likesCount: overrides.likesCount ?? 0,
    commentsCount: overrides.commentsCount ?? 0,
    sharesCount: overrides.sharesCount ?? 0,
    _count: overrides._count || { saved_posts: overrides.savesCount ?? 0 },
    likes: overrides.likes || [],
    saved_posts: overrides.saved_posts || [],
    ...overrides,
  };
}

test('rankFeed prioritizes profile affinity, follows, connections, and recent profile visits', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Kotlin', 'Machine Learning'],
    interests: ['Startups'],
    educationHints: ['VIT Chennai', 'Computer Science', 'B.Tech'],
    followingAuthorIds: ['followed-author'],
    connectionAuthorIds: ['connection-author'],
    recentProfileWeights: {
      'visited-author': 20,
    },
  });

  const genericPopular = post({
    id: 'generic-popular',
    content: 'Unrelated campus announcement',
    likesCount: 30,
    commentsCount: 8,
    sharesCount: 2,
  });
  const matchingFollowed = post({
    id: 'matching-followed',
    authorId: 'followed-author',
    content: 'Kotlin machine learning startup project for VIT Chennai students',
    college: 'VIT Chennai',
    branch: 'Computer Science',
    metadata: {
      articleTitle: 'Kotlin ML startup notes',
      articleTags: ['Kotlin', 'Machine Learning', 'Startups'],
    },
  });
  const connectionPost = post({
    id: 'connection-post',
    authorId: 'connection-author',
    content: 'Computer Science hackathon update',
    visibility: 'connections',
  });
  const visitedPost = post({
    id: 'visited-post',
    authorId: 'visited-author',
    content: 'Startup notes from a recently visited profile',
  });

  const ranked = rankFeed(
    [genericPopular, visitedPost, connectionPost, matchingFollowed],
    { ...context, nowMs: now }
  );

  assert.equal(ranked[0].id, 'matching-followed');
  assert.ok(ranked.findIndex((item) => item.id === 'connection-post') < ranked.findIndex((item) => item.id === 'generic-popular'));
  assert.ok(ranked.findIndex((item) => item.id === 'visited-post') < ranked.findIndex((item) => item.id === 'generic-popular'));
});

test('calculatePostScore applies a strong recent impression penalty', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['React'],
  });
  const subject = post({
    id: 'react-post',
    content: 'React portfolio guide',
    createdAt: new Date(now - 60 * 60 * 1000),
  });

  const freshScore = calculatePostScore(subject, { ...context, nowMs: now });
  const seenScore = calculatePostScore(subject, {
    ...context,
    nowMs: now,
    seenPostIds: ['react-post'],
    seenAtByPostId: {
      'react-post': new Date(now - 20 * 60 * 1000),
    },
  });

  assert.ok(seenScore < freshScore * 0.2);
});

test('recent impressions let unseen relevant posts replace already-seen popular posts', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Kotlin'],
  });
  const seenPopular = post({
    id: 'seen-popular',
    content: 'Kotlin Compose architecture guide',
    likesCount: 80,
    commentsCount: 20,
    createdAt: new Date(now - 30 * 60 * 1000),
  });
  const unseenRelevant = post({
    id: 'unseen-relevant',
    content: 'Kotlin state management notes',
    likesCount: 1,
    createdAt: new Date(now - 8 * 60 * 60 * 1000),
  });

  const ranked = rankFeed([seenPopular, unseenRelevant], {
    ...context,
    nowMs: now,
    seenPostIds: ['seen-popular'],
    seenAtByPostId: {
      'seen-popular': new Date(now - 10 * 60 * 1000),
    },
  });

  assert.equal(ranked[0].id, 'unseen-relevant');
});

test('metadata in article, link, and document fields contributes to relevance', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Rust'],
    interests: ['Open Source'],
  });

  const metadataMatch = post({
    id: 'metadata-match',
    content: '',
    type: 'article',
    metadata: {
      articleTitle: 'Rust open source maintainer handbook',
      articleTags: ['Rust', 'Open Source'],
      linkTitle: 'Rust project board',
      linkDescription: 'Open source contribution notes',
      linkDomain: 'github.com',
      documentName: 'Rust mentorship.pdf',
    },
  });
  const plain = post({
    id: 'plain',
    content: 'A short unrelated thought',
    likesCount: 5,
  });

  const ranked = rankFeed([plain, metadataMatch], { ...context, nowMs: now });

  assert.equal(ranked[0].id, 'metadata-match');
});

test('rankFeed spreads repeated authors after score ordering', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    followingAuthorIds: ['author-a', 'author-b'],
  });

  const ranked = rankFeed(
    [
      post({ id: 'a-1', authorId: 'author-a', content: 'Kotlin one', likesCount: 100 }),
      post({ id: 'a-2', authorId: 'author-a', content: 'Kotlin two', likesCount: 90 }),
      post({ id: 'b-1', authorId: 'author-b', content: 'Kotlin three', likesCount: 10 }),
    ],
    { ...context, nowMs: now }
  );

  assert.equal(ranked[0].authorId, 'author-a');
  assert.equal(ranked[1].authorId, 'author-b');
  assert.equal(ranked[2].authorId, 'author-a');
});

test('recommended feed pages over a larger stable ranked candidate window', () => {
  const candidateLimit = recommendedFeedCandidateLimit(20);
  assert.ok(candidateLimit > 20);
  assert.equal(candidateLimit, 80);
  assert.equal(recommendedFeedCandidateLimit(100), 200);

  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Kotlin'],
  });
  const sessionStartedAtMs = now;
  const cursorState = decodeRecommendedFeedCursor(null, sessionStartedAtMs);
  const candidates = Array.from({ length: 30 }, (_, index) =>
    post({
      id: `candidate-${index}`,
      authorId: `author-${index % 7}`,
      content: index >= 20 ? 'Kotlin recommendation candidate' : 'General feed item',
      createdAt: new Date(now - index * 60 * 1000),
      likesCount: index >= 20 ? 5 : 0,
    })
  );

  const firstPage = rankFeedPage(candidates, { ...context, nowMs: now }, {
    limit: 10,
    cursorState,
    hasMoreChronological: true,
    chronologicalBoundaryCursor: 'chronological-boundary',
  });
  const secondCursorState = decodeRecommendedFeedCursor(firstPage.nextCursor, now + 1000);
  const secondPage = rankFeedPage(candidates, { ...context, nowMs: now }, {
    limit: 10,
    cursorState: secondCursorState,
    hasMoreChronological: true,
    chronologicalBoundaryCursor: 'chronological-boundary',
  });

  assert.equal(firstPage.items.length, 10);
  assert.equal(secondPage.items.length, 10);
  assert.ok(firstPage.hasMore);
  assert.equal(secondCursorState.offset, 10);
  assert.equal(secondCursorState.sessionStartedAtMs, sessionStartedAtMs);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 20);
});

test('rankFeedPage caps oversized home infinite scroll pages', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Kotlin'],
  });
  const candidates = Array.from({ length: 220 }, (_, index) =>
    post({
      id: `hundred-page-${index}`,
      authorId: `author-${index % 20}`,
      content: index % 3 === 0 ? 'Kotlin feed item' : 'General feed item',
      createdAt: new Date(now - index * 60 * 1000),
    })
  );

  const firstPage = rankFeedPage(candidates, { ...context, nowMs: now }, {
    limit: 100,
    cursorState: decodeRecommendedFeedCursor(null, now),
    hasMoreChronological: true,
    chronologicalBoundaryCursor: 'chronological-boundary',
  });
  const secondPage = rankFeedPage(candidates, { ...context, nowMs: now }, {
    limit: 100,
    cursorState: decodeRecommendedFeedCursor(firstPage.nextCursor, now + 1000),
    hasMoreChronological: true,
    chronologicalBoundaryCursor: 'chronological-boundary',
  });

  assert.equal(firstPage.items.length, 50);
  assert.equal(secondPage.items.length, 50);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 100);
});

test('rankFeedPage puts unseen posts before previously seen posts on refresh', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Kotlin'],
  });
  const seenStrongMatch = post({
    id: 'seen-strong-match',
    content: 'Kotlin Compose feed algorithm',
    createdAt: new Date(now - 15 * 60 * 1000),
    likesCount: 100,
    commentsCount: 20,
  });
  const unseenWeakMatch = post({
    id: 'unseen-weak-match',
    content: 'Campus notice',
    createdAt: new Date(now - 2 * 60 * 60 * 1000),
  });

  const page = rankFeedPage([seenStrongMatch, unseenWeakMatch], {
    ...context,
    nowMs: now,
    seenPostIds: ['seen-strong-match'],
    seenAtByPostId: {
      'seen-strong-match': new Date(now - 20 * 60 * 1000),
    },
  }, {
    limit: 100,
    cursorState: decodeRecommendedFeedCursor(null, now),
  });

  assert.equal(page.items[0].id, 'unseen-weak-match');
});

test('rankFeedPage promotes fresh unseen posts on refresh', () => {
  const context = buildFeedRecommendationProfile({
    currentUserId: 'viewer-1',
    skills: ['Machine Learning', 'Kotlin'],
    followingAuthorIds: ['followed-author'],
  });
  const olderPerfectMatch = post({
    id: 'older-perfect-match',
    authorId: 'followed-author',
    content: 'Machine Learning Kotlin deep dive with article metadata',
    createdAt: new Date(now - 36 * 60 * 60 * 1000),
    likesCount: 100,
    commentsCount: 20,
    metadata: {
      articleTags: ['Machine Learning', 'Kotlin'],
      articleTitle: 'Kotlin ML guide',
    },
  });
  const freshUnseen = post({
    id: 'fresh-unseen',
    authorId: 'fresh-author',
    content: 'New campus post',
    createdAt: new Date(now - 5 * 60 * 1000),
  });

  const page = rankFeedPage([olderPerfectMatch, freshUnseen], { ...context, nowMs: now }, {
    limit: 10,
    cursorState: decodeRecommendedFeedCursor(null, now),
  });

  assert.equal(page.items[0].id, 'fresh-unseen');
});
