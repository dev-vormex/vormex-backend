import { assertSourceImports } from './helpers/implementation-source';
import { realtimeSource } from './helpers/source';
import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function block(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} was not found`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} was not found after ${startMarker}`);
  return text.slice(start, end);
}

const index = realtimeSource();

test('socket implementations import the shared trust-safety helpers', () => {
  const implementations = [
    'src/realtime/context.ts',
    'src/realtime/content-fanout.ts',
    'src/realtime/handlers/posts.handlers.ts',
  ].map(source).join('\n');
  assertSourceImports(implementations, 'safety/services/trust-safety.service', ['assertUsersCanInteract', 'enforceTrustTierLimit', 'getBlockedUserIds', 'safetyErrorResponse']);
});

test('post:comment fanout enforces trust tier limit and reply interaction safety', () => {
  const fn = block(index, 'async function createPostCommentWithFanout(', 'async function toggleCommentLikeWithFanout(');
  assert.match(fn, /enforceTrustTierLimit\(userId, 'comment'\)/);
  assert.match(fn, /select: \{ id: true, authorId: true \}/);
  assert.match(fn, /assertUsersCanInteract\(userId, parentComment\.authorId, 'comment reply'\)/);
  assert.ok(fn.indexOf("enforceTrustTierLimit(userId, 'comment')") < fn.indexOf('tx.post_comments.create('));
  assert.ok(fn.indexOf("'comment reply'") < fn.indexOf('tx.post_comments.create('));
});

test('comment:like fanout checks the comment author interaction', () => {
  const fn = block(index, 'async function toggleCommentLikeWithFanout(', 'tx.comment_likes.findUnique(');
  assert.match(fn, /authorId: true,\n\s*posts:/);
  assert.match(fn, /assertUsersCanInteract\(userId, comment\.authorId, 'comment reaction'\)/);
});

test('post:comment and comment:like handlers surface structured safety errors', () => {
  const commentHandler = block(index, "socket.on('post:comment'", "socket.on('comment:like'");
  const likeHandler = block(index, "socket.on('comment:like'", "socket.on('poll:vote'");
  for (const handler of [commentHandler, likeHandler]) {
    assert.match(handler, /const safety = safetyErrorResponse\(error\);/);
    assert.match(handler, /socket\.emit\('error', safety\.body\)/);
  }
});

test('presence and location emits exclude blocked users', () => {
  const rooms = block(index, 'async function getAuthorizedRealtimeRooms(', 'async function joinCoarseNearbyRoomIfAllowed(');
  assert.match(rooms, /getBlockedUserIds\(user\.id\)/);
  assert.match(rooms, /!blockedSet\.has\(connectionId\)/);

  const presence = block(index, 'async function emitPresenceToAuthorizedRooms(', 'function getSocketHandshakeToken(');
  assert.match(presence, /getBlockedRealtimeRooms\(user\.id\)/);
  assert.match(presence, /\.except\(blockedRooms\)\.emit\(eventName, payload\)/);

  const loc = block(index, "socket.on('location:update'", "socket.on('disconnect'");
  assert.match(loc, /getBlockedUserIds\(user\.id\)/);
  assert.match(loc, /!blockedSet\.has\(connectionId\)/);
  assert.match(loc, /\.except\(blockedRooms\)\.emit\('user:location_changed', payload\)/);
});
