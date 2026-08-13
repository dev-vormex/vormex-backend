import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function functionBlock(text: string, exportName: string): string {
  // Anchored on the ` =` so that asking for `getPost` cannot land on
  // `getPostUploadUrl` and quietly assert against the wrong function.
  const start = text.indexOf(`export const ${exportName} =`);
  assert.notEqual(start, -1, `${exportName} was not found`);
  const next = text.indexOf('\nexport const ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

test('home feed merges the keyset cursor into the visibility gate instead of replacing it', () => {
  const block = functionBlock(source('src/controllers/post.controller.ts'), 'getFeed');

  /*
   * buildPostVisibilityWhere returns its gate under an `AND` key, so spreading
   * it into the same object literal as any other `AND` silently drops it. That
   * regression served every author's connections-only and private posts to any
   * caller paginating `?mode=latest`, from page 2 onward.
   */
  assert.doesNotMatch(block, /\.\.\.accessWhere/);
  assert.match(block, /const accessAnd = Array\.isArray\(accessWhere\.AND\)/);
  assert.match(
    block,
    /AND: \[\s*\.\.\.accessAnd,\s*\.\.\.\(mode === 'latest' && latestCursorWhere \? \[latestCursorWhere\] : \[\]\),\s*\]/
  );
});

test('every post read path gates on the shared visibility helpers', () => {
  const controller = source('src/controllers/post.controller.ts');

  for (const exportName of ['getPost', 'getComments', 'getLikes', 'sharePost']) {
    assert.match(
      functionBlock(controller, exportName),
      /canViewPost|buildPostVisibilityWhere/,
      `${exportName} returns post data without a visibility gate`
    );
  }

  // Saved rows outlive the visibility they were saved under, so the audience is
  // re-checked at read time rather than trusted from when the save happened.
  assert.match(
    functionBlock(source('src/controllers/saved.controller.ts'), 'getSaved'),
    /canViewPost\(item\.posts, userId\)/
  );

  // Rejecting a collaboration invite leaves the invitee outside the audience,
  // so that response must not hand back what GET /posts/:postId would refuse.
  assert.match(
    functionBlock(controller, 'respondToPostCollabInvite'),
    /post: updatedPost && canReadUpdatedPost \? mapPostResponse\(updatedPost, userId\) : null/
  );
});

test('mention notifications never carry a post body past its own audience', () => {
  const block = functionBlock(source('src/controllers/post.controller.ts'), 'createPost');

  // The notification preview is the raw post body, so a recipient who cannot
  // open the post must not be told about it at all.
  assert.match(block, /const canReadById = new Map\(/);
  assert.match(
    block,
    /mentionableUsers\s*\.filter\(\(mentionedUser\) => canReadById\.get\(mentionedUser\.id\)\)/
  );
  // Collaborator invites still go out, but withhold the body until acceptance.
  assert.match(
    block,
    /canReadById\.get\(collaboratorUser\.id\) \? \(content \|\| genericPreview\) : genericPreview/
  );
});

test('post creation fans out only to the selected audience', () => {
  const block = functionBlock(source('src/controllers/post.controller.ts'), 'createPost');

  assert.match(block, /if \(visibility === 'public'\)[\s\S]{0,200}?rooms: \[FEED_REALTIME_ROOM\]/);
  assert.match(block, /visibility === 'connections'[\s\S]{0,200}?users: \[userId, \.\.\.peerIds\]/);
  // Private posts reach the author's own sockets and nobody else's.
  assert.match(block, /\} else \{[\s\S]{0,200}?users: \[userId\]/);
});

test('profile feed applies the viewer visibility gate and keys its cache per viewer', () => {
  const service = source('src/services/profile.service.ts');

  // Posts and articles are queried separately; both need the gate.
  assert.equal((service.match(/buildPostVisibilityWhere\(requestingUserId\)/g) || []).length, 2);
  // A cache key without the viewer would replay one viewer's page to another.
  assert.match(service, /profile:feed:\$\{requestingUserId \|\| 'anon'\}/);
});

test('the visibility gate itself only widens for the author, connections and collaborators', () => {
  const util = source('src/utils/access-control.util.ts');
  const block = util.slice(
    util.indexOf('export async function buildPostVisibilityWhere'),
    util.indexOf('export async function canViewPost')
  );

  // Anonymous viewers get public only: every widening sits behind `if (viewerId)`.
  assert.match(block, /visibilityOr: Array<Record<string, unknown>> = \[\s*\{ visibility: \{ in: PUBLIC_VISIBILITIES \} \},\s*\]/);
  assert.ok(block.indexOf('if (viewerId) {') < block.indexOf('visibilityOr.push({ authorId: viewerId })'));
  // Connections-only posts stay scoped to accepted peers, never all authors.
  assert.match(
    block,
    /visibility: \{ in: CONNECTION_VISIBILITIES \} \},\s*\{ authorId: \{ in: connectedPeerIds \} \}/
  );
  assert.doesNotMatch(block, /PRIVATE/);
});
