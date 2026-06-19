import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function functionBlock(text: string, exportName: string): string {
  const start = text.indexOf(`export const ${exportName}`);
  assert.notEqual(start, -1, `${exportName} was not found`);
  const next = text.indexOf('\nexport const ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

test('chat hot lists use signed keyset cursors and capped message page size', () => {
  const controller = source('src/controllers/chat.controller.ts');
  const conversationsBlock = functionBlock(controller, 'getConversations');
  const messagesBlock = functionBlock(controller, 'getMessages');

  assert.match(conversationsBlock, /decodeKeysetCursor\(cursorValue, 'chat\.conversations'\)/);
  assert.match(conversationsBlock, /encodeKeysetCursor\(\{\s*scope: 'chat\.conversations'/s);
  assert.match(conversationsBlock, /take: limit \+ 1/);
  assert.match(messagesBlock, /clampPageSize\(req\.query\.limit, 50, 50\)/);
  assert.match(messagesBlock, /createdAtDescKeysetWhere\(cursor\)/);
  assert.match(messagesBlock, /encodeKeysetCursor\(\{\s*scope: `chat\.messages:\$\{conversationId\}`/s);
});

test('people discovery removed offset and count from the hot path', () => {
  const controller = source('src/controllers/people.controller.ts');
  const getPeopleBlock = functionBlock(controller, 'getPeople');

  assert.match(getPeopleBlock, /decodePeopleCursor\(req\.query\.cursor\)/);
  assert.match(getPeopleBlock, /take: requestedTake/);
  assert.match(getPeopleBlock, /totalIsApproximate: true/);
  assert.doesNotMatch(getPeopleBlock, /skip:/);
  assert.doesNotMatch(getPeopleBlock, /\.count\(/);
});

test('notifications and feed latest return signed keyset cursors without hot counts', () => {
  const notifications = source('src/controllers/notifications.controller.ts');
  const notificationListBlock = functionBlock(notifications, 'getNotifications');
  const postController = source('src/controllers/post.controller.ts');
  const feedBlock = functionBlock(postController, 'getFeed');

  assert.match(notificationListBlock, /decodeKeysetCursor\(cursorValue, 'notifications'\)/);
  assert.match(notificationListBlock, /take: rawTake/);
  assert.match(notificationListBlock, /encodeKeysetCursor\(\{\s*scope: 'notifications'/s);
  assert.doesNotMatch(notificationListBlock, /\.count\(/);
  assert.match(feedBlock, /decodeKeysetCursor\(cursor, 'feed\.latest'\)/);
  assert.match(feedBlock, /createdAtDescKeysetWhere\(latestCursor\)/);
  assert.match(feedBlock, /encodeKeysetCursor\(\{ scope: 'feed\.latest'/);
});

test('reels list endpoints use signed keyset cursors and matching migration indexes', () => {
  const reels = source('src/controllers/reels.controller.ts');
  const migration = source('prisma/migrations/20260608193000_keyset_pagination_indexes/migration.sql');
  const schema = source('prisma/schema.prisma');

  assert.match(reels, /applyDateCursor\(whereClause, cursor, feedScope, 'publishedAt'\)/);
  assert.match(reels, /encodeDateCursor\(feedScope, pageItems\[pageItems\.length - 1\], 'publishedAt'\)/);
  assert.match(reels, /const scope = `reels\.hashtag:\$\{hashtag\}`/);
  assert.match(reels, /const scope = `reels\.audio:\$\{audioId\}`/);
  assert.match(reels, /const scope = `reels\.liked:\$\{userId\}`/);
  assert.match(reels, /const scope = `reels\.saved:\$\{userId\}`/);
  assert.match(reels, /const scope = `reels\.drafts:\$\{userId\}`/);
  assert.match(migration, /"messages" \("conversationId", "createdAt", "id"\)/);
  assert.match(migration, /"notifications" \("userId", "isRead", "createdAt", "id"\)/);
  assert.match(migration, /"reels" \("status", "visibility", "publishedAt", "id"\)/);
  assert.match(schema, /@@index\(\[conversationId, createdAt, id\]\)/);
  assert.match(schema, /@@index\(\[status, visibility, publishedAt, id\]\)/);
});

test('reels feed uses limit plus one cursor pagination without offset or count', () => {
  const reels = source('src/controllers/reels.controller.ts');
  const feedBlock = functionBlock(reels, 'getReelsFeed');

  assert.match(feedBlock, /clampPageSize\(req\.query\.limit, 10, 30\)/);
  assert.match(feedBlock, /orderBy: \[\{ publishedAt: 'desc' \}, \{ id: 'desc' \}\]/);
  assert.match(feedBlock, /take: limit \+ 1/);
  assert.match(feedBlock, /const hasMore = reels\.length > limit/);
  assert.match(feedBlock, /const pageItems = hasMore \? reels\.slice\(0, limit\) : reels/);
  assert.match(feedBlock, /nextCursor: hasMore \? encodeDateCursor/);
  assert.doesNotMatch(feedBlock, /skip:/);
  assert.doesNotMatch(feedBlock, /\.count\(/);
});
