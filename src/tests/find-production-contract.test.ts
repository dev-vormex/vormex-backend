import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function functionBlock(text: string, exportName: string): string {
  const start = text.indexOf(`export const ${exportName}`);
  assert.notEqual(start, -1, `${exportName} was not found`);
  const next = text.indexOf('\nexport const ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

test('global browse uses a stable database boundary before in-page premium ordering', () => {
  const block = functionBlock(source('src/controllers/people.controller.ts'), 'getPeople');
  assert.match(block, /applyDefaultLocalScope: false/);
  assert.match(block, /take: limit \+ 1/);
  assert.ok(block.indexOf('databaseOrderedPage') < block.indexOf('sortByPremiumVisibility'));
  assert.match(block, /nextCursor: hasMore && databaseOrderedPage\.length > 0/);
  assert.doesNotMatch(block, /slice\(0, limit\).*encodePeopleCursor\(users/s);
});

test('indexed search binds signed cursors to normalized query and excludes unsafe users', () => {
  const controller = source('src/controllers/people.controller.ts');
  const block = functionBlock(controller, 'searchPeople');
  assert.match(controller, /peopleSearchScope = \(query: string\)/);
  assert.match(block, /decodePeopleSearchCursor\(req\.query\.cursor, normalizedQuery\)/);
  assert.match(block, /d\."searchVector" @@ websearch_to_tsquery/);
  assert.match(block, /u\."id" <> \$\{userId\}/);
  assert.match(block, /u\."isBanned" = false/);
  assert.match(block, /blockedClause/);
  assert.match(block, /ORDER BY "rank" DESC, "lastActiveAt" DESC NULLS LAST, "id" ASC/);
  assert.match(block, /LIMIT \$\{limit \+ 1\}/);
});

test('person cards and mutations expose canonical relationship state', () => {
  const people = source('src/controllers/people.controller.ts');
  const connections = source('src/controllers/connection.controller.ts');
  assert.match(people, /relationship: \{\s*status: connectionStatus,\s*connectionId/s);
  assert.match(connections, /canonicalRelationship\('pending_sent', connection\.id\)/);
  assert.match(connections, /canonicalRelationship\('connected', connection\.id\)/);
  assert.match(connections, /message: 'Connection request already pending'/);
  assert.match(connections, /message: 'Connection request already accepted'/);
});

test('withdrawing a request settles the relationship instead of failing on a stale id', () => {
  const connections = source('src/controllers/connection.controller.ts');
  const routes = source('src/routes/connection.routes.ts');
  const block = connections.slice(
    connections.indexOf('const withdrawSentRequest'),
    connections.indexOf('export const cancelConnectionRequest')
  );

  /*
   * Cancelling used to 404 on a missing row and 400 on a non-pending one. Both
   * clients read any non-2xx as "the cancel failed" and roll back to Pending, so
   * an id that had outlived its row — a cached profile payload, a second tab that
   * already cancelled — left a Pending button that no retry could ever clear.
   */
  assert.doesNotMatch(block, /res\.status\(404\)/);
  assert.match(block, /if \(!connection\) \{\s*res\.status\(200\)/);
  assert.match(block, /message: 'Connection request already cancelled'/);
  assert.match(block, /connection\.status !== 'pending'[\s\S]{0,120}res\.status\(200\)/);

  // "Nothing of yours to withdraw" still describes where the pair stands, so the
  // client repaints instead of reverting to a phantom Pending. Only a row that
  // belongs to neither party is a real authorization failure.
  assert.match(block, /message: 'Already connected'[\s\S]{0,120}canonicalRelationship\('connected'/);
  assert.match(block, /message: 'Connection request was sent to you'/);
  assert.equal((block.match(/res\.status\(403\)/g) || []).length, 1);

  // A surface that never learned the id can still withdraw by recipient, and the
  // literal segment has to be declared before the bare `/:connectionId` delete.
  assert.match(connections, /export const cancelSentRequestToUser/);
  assert.ok(
    routes.indexOf(`delete('/user/:userId/request'`) < routes.indexOf(`delete('/:connectionId'`),
    'by-user cancel must be declared before the catch-all connection id delete'
  );

  // Deleting under the requester+pending predicate keeps a concurrent accept
  // from being withdrawn out from under the other side.
  assert.match(block, /deleteMany\(\{[\s\S]{0,200}requesterId: viewerId, status: 'pending'/);
});

test('profile sections remain separate from feed and activity endpoints', () => {
  const service = source('src/services/profile.service.ts');
  const routes = source('src/routes/profile.routes.ts');
  const block = service.slice(
    service.indexOf('export async function getProfileSections'),
    service.indexOf('/**\n * Get full profile', service.indexOf('export async function getProfileSections'))
  );
  assert.match(routes, /\/users\/:userId\/profile\/sections/);
  assert.match(block, /prisma\.userSkill\.findMany/);
  assert.match(block, /prisma\.experience\.findMany/);
  assert.doesNotMatch(block, /getUnifiedContentFeed/);
  assert.doesNotMatch(block, /getActivityHeatmap/);
});
