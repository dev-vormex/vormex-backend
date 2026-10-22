import { assertSourceImports } from './helpers/implementation-source';
import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function exportBlock(text: string, exportName: string): string {
  const start = text.indexOf(`export const ${exportName} =`);
  assert.notEqual(start, -1, `${exportName} was not found`);
  const next = text.indexOf('\nexport const ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

const HIDDEN = /error: 'This resource is unavailable\.', code: 'resource_unavailable', retryable: false/;

test('talk people search applies the shared discovery policy without clobbering the search OR', () => {
  const text = source('src/modules/ai/controllers/talk.controller.ts');
  assertSourceImports(text, "safety/services/safety-policy", ["discoverableUsersWhere"]);
  assert.match(text, /getBlockedUserIds/);
  assert.match(text, /discoverableUsersWhere\(userId, blockedUserIds\)/);
  assert.match(text, /AND: \[\{ OR: suspensionOr \}\]/);
  assert.match(text, /buildPeopleWhere\(userId, terms, currentUser, blockedUserIds\)/);
});

test('talk profile preview checks the viewer per request and never serves a viewer-agnostic cached body', () => {
  const block = exportBlock(source('src/modules/ai/controllers/talk.controller.ts'), 'getTalkProfilePreview');
  const lookupStore = block.indexOf('{ id: targetUserId }');
  const viewCheck = block.indexOf('assertCanViewUser(requestingUserId, targetUserId)');
  const firstBodyCache = block.indexOf('cacheService.get<any>(cacheKey)');
  assert.ok(lookupStore !== -1 && viewCheck !== -1 && firstBodyCache !== -1);
  assert.ok(viewCheck < firstBodyCache, 'viewer check must precede any cached body read');
  // The lookup cache stores id resolution only, never the response body.
  assert.doesNotMatch(block, /cacheService\.set\(lookupCacheKey,\s*(cached|response)/);
  assert.match(block, /safetyErrorResponse\(error\)/);
});

test('talk profile preview gates location with evaluateLocationVisibility and caches it as null', () => {
  const text = source('src/modules/ai/controllers/talk.controller.ts');
  const block = exportBlock(text, 'getTalkProfilePreview');
  assert.match(text, /evaluateLocationVisibility/);
  assert.match(block, /select: \{ location: true, shareLocationPublic: true \}/);
  assert.match(block, /isOwner: requestingUserId === targetUserId/);
  assert.match(block, /location: null, \/\/ viewer-specific/);
  assert.match(block, /res\.status\(200\)\.json\(withViewerLocation\(cached\)\)/);
  assert.match(block, /res\.status\(200\)\.json\(withViewerLocation\(response\)\)/);
  assert.match(text, /talk:profile-preview:v2:/);
  assert.match(text, /talk:profile-preview-lookup:v2:/);
});

test('people-you-know re-applies discovery rules at read time and sync time', () => {
  const text = source('src/modules/discovery/controllers/people-contacts.controller.ts');
  assertSourceImports(text, "safety/services/safety-policy", ["discoverableUsersWhere","evaluateDiscoveryCandidate"]);
  assertSourceImports(text, "safety/services/trust-safety.service", ["getBlockedUserIds"]);
  assert.match(text, /discoverableUsersWhere\(currentUserId, blockedUserIds\)/);
  assert.match(text, /\.\.\.discoverable, id: \{ in: matchedUserIds, notIn: discoverable\.id\.notIn \}/);
  assert.match(text, /evaluateDiscoveryCandidate\(\{/);
  assert.match(text, /entriesByEmailHash\.delete\(user\.emailHash\)/);
});

test('skills passport, suggestions, endorse, request and accept use the shared helpers', () => {
  const text = source('src/modules/skills/controllers/skills.controller.ts');
  assertSourceImports(text, "safety/services/trust-safety.service", ["assertCanViewUser", "assertUsersCanInteract", "getBlockedUserIds", "safetyErrorResponse"]);

  const passport = exportBlock(text, 'getSkillPassport');
  assert.match(passport, /assertCanViewUser\(requestingUserId, user\.id\)/);
  assert.match(passport, /getBlockedUserIds\(requestingUserId\)/);
  assert.match(passport, /safetyErrorResponse\(error\)/);

  const suggestions = exportBlock(text, 'getSkillSwapSuggestions');
  assert.match(suggestions, /where: discoverableUsersWhere\(userId, await getBlockedUserIds\(userId\)\)/);

  assert.match(exportBlock(text, 'endorseSkill'), /assertUsersCanInteract\(endorserId, targetUserId, 'endorsement'\)/);
  assert.match(exportBlock(text, 'endorseSkill'), /safetyErrorResponse\(error\)/);
  assert.match(exportBlock(text, 'createSkillSwapRequest'), /assertUsersCanInteract\(requesterId, recipientId, 'skill swap request'\)/);
  assert.match(exportBlock(text, 'createSkillSwapRequest'), /safetyErrorResponse\(error\)/);

  const respond = exportBlock(text, 'respondToSkillSwapRequest');
  const decline = respond.indexOf("action === 'decline'");
  const guard = respond.indexOf("assertUsersCanInteract(userId, request.requesterId, 'skill swap')");
  assert.ok(guard > decline, 'decline stays allowed; only accept is gated');
  assert.match(respond, /safetyErrorResponse\(error\)/);
});

test('follow mutual info and counts hide blocked users with the standard 404', () => {
  const text = source('src/modules/connections/controllers/follow.controller.ts');

  const mutual = exportBlock(text, 'getMutualInfo');
  assert.match(mutual, /areUsersBlocked\(viewerUserId, userId\)/);
  assert.match(mutual, HIDDEN);
  assert.match(mutual, /getBlockedUserIds\(viewerUserId\)/);
  assert.match(mutual, /!blockedUserIds\.has\(id\)/);

  const counts = exportBlock(text, 'getFollowCounts');
  assert.match(counts, /countsViewerId && countsViewerId !== userId && await areUsersBlocked\(countsViewerId, userId\)/);
  assert.match(counts, HIDDEN);
  assert.doesNotMatch(counts, /Unauthorized/);
});
