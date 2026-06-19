import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `${start} not found`);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `${end} not found after ${start}`);
  return text.slice(startIndex, endIndex);
}

test('connection accept guards pending transition and increments stats in the same transaction', () => {
  const controller = source('src/controllers/connection.controller.ts');
  const handler = between(
    controller,
    'export const acceptConnectionRequest',
    'export const rejectConnectionRequest'
  );

  assert.match(handler, /prisma\.\$transaction/);
  assert.match(handler, /tx\.connections\.updateMany\(\{\s*where: \{ id: connectionId, addresseeId: req\.user!\.userId, status: 'pending' \}/s);
  assert.match(handler, /if \(acceptResult\.count !== 1\)/);
  assert.match(handler, /tx\.userStats\.upsert/);
  assert.doesNotMatch(handler, /prisma\.userStats\.updateMany/);
});

test('follow and unfollow mutate follow row and counters atomically without swallowed stats errors', () => {
  const controller = source('src/controllers/follow.controller.ts');
  const followHandler = between(controller, 'export const followUser', 'export const unfollowUser');
  const unfollowHandler = between(controller, 'export const unfollowUser', 'export const getFollowStatus');

  assert.match(followHandler, /prisma\.\$transaction/);
  assert.match(followHandler, /tx\.follows\.create/);
  assert.match(followHandler, /followingCount: \{ increment: 1 \}/);
  assert.match(followHandler, /followersCount: \{ increment: 1 \}/);
  assert.match(followHandler, /isUniqueViolation/);

  assert.match(unfollowHandler, /prisma\.\$transaction/);
  assert.match(unfollowHandler, /tx\.follows\.deleteMany/);
  assert.match(unfollowHandler, /if \(result\.count !== 1\)/);
  assert.match(unfollowHandler, /followingCount: \{ decrement: 1 \}/);
  assert.match(unfollowHandler, /followersCount: \{ decrement: 1 \}/);
  assert.doesNotMatch(unfollowHandler, /\.catch\(\(\) => \{\}\)/);
});

test('reel like/share/comment/report use guarded transactional counter updates', () => {
  const controller = source('src/controllers/reels.controller.ts');
  const likeHandler = between(controller, 'export const toggleLike', 'export const toggleSave');
  const shareHandler = between(controller, 'export const shareReel =', '// Share reel in chat');
  const commentHandler = between(controller, 'export const createComment', 'export const toggleCommentLike');
  const reportHandler = between(controller, 'export const reportReel', 'export const transcodingWebhook');

  assert.match(likeHandler, /prisma\.\$transaction/);
  assert.match(likeHandler, /tx\.reel_likes\.deleteMany/);
  assert.match(likeHandler, /likesCount: \{ decrement: 1 \}/);
  assert.match(likeHandler, /tx\.reel_likes\.create/);
  assert.match(likeHandler, /likesCount: \{ increment: 1 \}/);
  assert.match(likeHandler, /isUniqueViolation/);
  assert.doesNotMatch(likeHandler, /reel_likes\.count/);

  assert.match(shareHandler, /prisma\.\$transaction/);
  assert.match(shareHandler, /tx\.reel_shares\.create/);
  assert.match(shareHandler, /sharesCount: \{ increment: 1 \}/);
  assert.match(shareHandler, /createdShare && reel\.authorId !== userId/);
  assert.match(shareHandler, /isUniqueViolation/);

  assert.match(commentHandler, /prisma\.\$transaction/);
  assert.match(commentHandler, /tx\.reel_comments\.create/);
  assert.match(commentHandler, /repliesCount: \{ increment: 1 \}/);
  assert.match(commentHandler, /commentsCount: \{ increment: 1 \}/);
  assert.doesNotMatch(commentHandler, /reel_comments\.count/);

  assert.match(reportHandler, /prisma\.reel_reports\.create/);
  assert.match(reportHandler, /isUniqueViolation/);
});

test('social counter migration adds idempotency indexes and reconciles existing duplicate shares', () => {
  const migration = source('prisma/migrations/20260608183000_idempotent_social_counters/migration.sql');
  const schema = source('prisma/schema.prisma');

  assert.match(migration, /ROW_NUMBER\(\) OVER/);
  assert.match(migration, /UPDATE "reels" r\s+SET "sharesCount"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "reel_reports_reelId_reporterId_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "reel_shares_reelId_userId_key"/);
  assert.match(schema, /model reel_reports[\s\S]*@@unique\(\[reelId, reporterId\]\)/);
  assert.match(schema, /model reel_shares[\s\S]*@@unique\(\[reelId, userId\]\)/);
});
