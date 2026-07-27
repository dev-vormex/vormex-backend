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
