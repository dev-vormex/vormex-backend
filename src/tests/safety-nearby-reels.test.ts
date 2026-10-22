import { assertSourceImports } from './helpers/implementation-source';
import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function exportBlock(text: string, exportName: string): string {
  const start = text.indexOf(`export const ${exportName} =`);
  assert.notEqual(start, -1, `${exportName} was not found`);
  const next = text.indexOf('\nexport const ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

function functionBlock(text: string, signature: string): string {
  const start = text.indexOf(signature);
  assert.notEqual(start, -1, `${signature} was not found`);
  const next = text.indexOf('\nexport ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

const reels = source('src/modules/content/controllers/reels.controller.ts');

test('location nearby query excludes blocked and suspended users in SQL', () => {
  const text = source('src/modules/proximity/controllers/location.controller.ts');
  assertSourceImports(text, "safety/services/trust-safety.service", ["getBlockedUserIds"]);
  assert.match(text, /await getBlockedUserIds\(userId\)/);
  assert.match(text, /"id" NOT IN \(\$\{Prisma\.join\(blockedUserIds\)\}\)/);
  assert.match(text, /"safetySuspendedUntil" IS NULL OR "safetySuspendedUntil" <= CURRENT_TIMESTAMP/);
  // exclusion must be inside the SQL (before LIMIT/OFFSET), not a post-filter
  assert.ok(text.indexOf('${blockedClause}') < text.indexOf('LIMIT ${limit + 1}'));
});

test('discovery-power nearby ids and people discovery where apply block/suspension filters', () => {
  const text = source('src/modules/discovery/services/discovery-power.service.ts');
  assertSourceImports(text, "safety/services/trust-safety.service", ["getBlockedUserIds"]);

  const nearby = functionBlock(text, 'export async function getNearbyDiscoveryUserIds');
  assert.match(nearby, /getBlockedUserIds\(params\.userId\)/);
  assert.match(nearby, /"id" NOT IN \(\$\{Prisma\.join\(blockedUserIds\)\}\)/);
  assert.match(nearby, /"safetySuspendedUntil" IS NULL OR "safetySuspendedUntil" <= CURRENT_TIMESTAMP/);

  const where = functionBlock(text, 'export async function buildPeopleDiscoveryWhere');
  assert.match(where, /await getBlockedUserIds\(userId\)/);
  assert.match(where, /id: \{ notIn: \[userId, \.\.\.blockedUserIds\] \}/);

  // saved-search scans go through buildPeopleDiscoveryWhere and so inherit the filter
  assert.match(functionBlock(text, 'async function findSavedSearchMatchIds'), /buildPeopleDiscoveryWhere\(/);
});

test('recommendation learning cascade audiences use the shared (device-scoped) block set', () => {
  const text = source('src/modules/discovery/services/recommendation-learning.service.ts');
  assertSourceImports(text, "safety/services/trust-safety.service", ["getBlockedUserIds"]);
  assert.match(text, /getBlockedUserIds\(String\(reaction\.author_id\)\)/);
  assert.match(text, /input\.authorId \? await getBlockedUserIds\(input\.authorId\)/);
  assert.equal((text.match(/\$\{authorBlockedClause\}/g) || []).length, 2);
});

test('reels feed and trending exclude blocked authors for authenticated viewers', () => {
  const feed = exportBlock(reels, 'getReelsFeed');
  assert.match(feed, /getBlockedUserIds\(currentUserId\)/);
  assert.match(feed, /whereClause\.authorId = \{ notIn: blockedUserIds \}/);
  assert.match(feed, /filter\(\(id\) => !blockedSet\.has\(id\)\)/);
  // the shared cache key is anonymous-only, so a cached page can never skip the block filter
  assert.match(feed, /const cacheKey = !currentUserId && mode !== 'following'/);

  const trending = exportBlock(reels, 'getTrendingReels');
  assert.match(trending, /getBlockedUserIds\(currentUserId\)/);
  assert.match(trending, /authorId: \{ notIn: blockedUserIds \}/);
});

test('hashtag, audio and user reel lists never expose unpublished (scheduled) reels', () => {
  assert.match(exportBlock(reels, 'getReelsByHashtag'), /publishedAt: \{ not: null \}/);
  assert.match(exportBlock(reels, 'getReelsByAudio'), /publishedAt: \{ not: null \}/);
  const userReels = exportBlock(reels, 'getUserReels');
  assert.match(userReels, /whereClause\.publishedAt = \{ not: null \}/);
  // owners still see their own list (scheduled reels) - the gate sits inside the non-owner branch
  assert.match(userReels, /if \(currentUserId !== userId\) \{[^}]*publishedAt/);
});

test('reel comments enforce trust tier + interaction safety and map errors via safetyErrorResponse', () => {
  const create = exportBlock(reels, 'createComment');
  assert.match(create, /enforceTrustTierLimit\(userId, 'comment'\)/);
  assert.match(create, /assertUsersCanInteract\(userId, reel\.authorId, 'comment'\)/);
  assert.match(create, /assertUsersCanInteract\(userId, parentComment\.authorId, 'comment reply'\)/);
  assert.match(create, /safetyErrorResponse\(error\)/);
  assert.match(create, /res\.status\(safety\.statusCode\)\.json\(safety\.body\)/);

  const like = exportBlock(reels, 'toggleCommentLike');
  assert.match(like, /authorId: true/);
  assert.match(like, /assertUsersCanInteract\(userId, comment\.authorId, 'comment reaction'\)/);
  assert.match(like, /safetyErrorResponse\(error\)/);
});

test('reel comment @mention notifications require canViewReel and shouldNotifyUser', () => {
  const create = exportBlock(reels, 'createComment');
  assertSourceImports(reels, "safety/services/trust-safety.service", ["shouldNotifyUser"]);
  const mentionIdx = create.indexOf('notificationService.notifyMention');
  assert.notEqual(mentionIdx, -1);
  const guard = create.slice(0, mentionIdx);
  assert.match(guard, /canViewReel\(reel, mentionedUser\.id\)/);
  assert.match(guard, /shouldNotifyUser\(userId, mentionedUser\.id\)/);
});

test('onUploadComplete no longer spreads the raw request body into prisma.reels.create', () => {
  const block = exportBlock(reels, 'onUploadComplete');
  assert.doesNotMatch(block, /\.\.\.metadata,/);
  assert.match(block, /\.\.\.pickReelUploadMetadata\(metadata\),/);
});

function loadPicker(): (metadata: any) => Record<string, unknown> {
  const start = reels.indexOf('const REEL_UPLOAD_METADATA_STRING_ARRAY_KEYS');
  const end = reels.indexOf('export const onUploadComplete =');
  assert.ok(start !== -1 && end > start);
  const js = ts.transpileModule(reels.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new Function(`${js}\nreturn pickReelUploadMetadata;`)();
}

test('pickReelUploadMetadata only passes the allowlisted descriptive fields', () => {
  const pick = loadPicker();
  const malicious = {
    id: 'attacker-id',
    authorId: 'victim',
    status: 'ready',
    publishedAt: new Date(),
    viewsCount: 1_000_000,
    likesCount: 5,
    isFeatured: true,
    videoId: 'x',
    saveAsDraft: true,
    durationSeconds: 5,
    users: { connect: { id: 'victim' } },
  };
  assert.deepEqual(pick(malicious), {});

  const legit = {
    mentions: ['a', 'b'],
    skills: ['ts'],
    topics: ['dev'],
    allowComments: false,
    allowDuets: true,
    allowStitch: false,
    allowDownload: true,
    allowSharing: false,
    category: 'tech',
    codeSnippet: 'x',
    codeLanguage: 'ts',
    codeFileName: 'a.ts',
    repoUrl: 'https://example.com/r',
  };
  assert.deepEqual(pick({ ...legit, ...malicious }), legit);
});

test('pickReelUploadMetadata drops wrongly typed values and tolerates empty input', () => {
  const pick = loadPicker();
  assert.deepEqual(pick(undefined), {});
  assert.deepEqual(pick(null), {});
  assert.deepEqual(pick({ mentions: 'a', skills: [1], allowComments: 'false', category: 3 }), {});
});
