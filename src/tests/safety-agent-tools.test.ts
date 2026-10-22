import ts from 'typescript';
import { assertSourceImports } from './helpers/implementation-source';
import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

const tools = source('src/modules/agent/utils/tools.ts');

function caseBlock(name: string): string {
  const handler = name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()) + 'Tool';
  const parsed = ts.createSourceFile('tools.ts', tools, ts.ScriptTarget.Latest, true);
  const operation = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === handler);
  assert.ok(operation && ts.isFunctionDeclaration(operation), name + ' handler was not found');
  assert.match(tools, new RegExp("case ['\"]" + name + "['\"]: return " + handler + "\\("));
  return operation.body!.getText(parsed);
}

test('agent tools import the shared trust-safety and safety-policy helpers', () => {
  assertSourceImports(tools, "safety/services/trust-safety.service", ["assertUsersCanInteract"]);
  for (const name of [
    'assertCanViewUser',
    'assertUsersCanInteract',
    'enforceTrustTierLimit',
    'getDiscoverableUsersWhere',
    'safetyErrorResponse',
    'SafetyActionError',
  ]) {
    assert.match(tools, new RegExp(`\\b${name}\\b`), `${name} should be imported`);
  }
  assertSourceImports(tools, "safety/services/safety-policy", ["evaluateLocationVisibility"]);
});

test('safetyToolFailure maps SafetyActionError to the blocked-tool shape', () => {
  assert.match(tools, /function safetyToolFailure\(/);
  assert.match(tools, /const mapped = safetyErrorResponse\(err\);\n\s+if \(!mapped\) return null;/);
  assert.match(tools, /reason: mapped\.body\.code/);
});

test('chat_open_conversation checks interaction and dm trust tier before opening', () => {
  const block = caseBlock('chat_open_conversation');
  assert.match(block, /assertUsersCanInteract\(ctx\.userId, targetUserId, 'message'\)/);
  assert.match(block, /enforceTrustTierLimit\(ctx\.userId, 'dm'\)/);
  assert.ok(block.indexOf('assertUsersCanInteract') < block.indexOf('getOrCreateConversationForUsers'));
  assert.ok(block.indexOf("enforceTrustTierLimit(ctx.userId, 'dm')") < block.indexOf('getOrCreateConversationForUsers'));
});

test('chat_send_message checks interaction and dm trust tier before writing the message', () => {
  const block = caseBlock('chat_send_message');
  assert.match(block, /assertUsersCanInteract\(ctx\.userId, targetUserId, 'message'\)/);
  assert.match(block, /enforceTrustTierLimit\(ctx\.userId, 'dm'\)/);
  assert.ok(block.indexOf('assertUsersCanInteract') < block.indexOf('getOrCreateConversationForUsers'));
  assert.ok(block.indexOf("enforceTrustTierLimit(ctx.userId, 'dm')") < block.indexOf('prisma.messages.create'));
});

test('connections_send_request checks target, interaction and trust tier before creating', () => {
  const block = caseBlock('connections_send_request');
  assert.match(block, /prisma\.user\.findUnique/);
  assert.match(block, /reason: 'user_not_found'/);
  assert.match(block, /assertUsersCanInteract\(ctx\.userId, targetUserId, 'connection request'\)/);
  assert.match(block, /enforceTrustTierLimit\(ctx\.userId, 'connection_request'\)/);
  assert.ok(block.indexOf('enforceTrustTierLimit') < block.indexOf('prisma.connections.create'));
});

test('connections_accept_request checks interaction with the requester before accepting', () => {
  const block = caseBlock('connections_accept_request');
  assert.match(block, /assertUsersCanInteract\(ctx\.userId, connection\.requesterId, 'connection request'\)/);
  assert.ok(block.indexOf('assertUsersCanInteract') < block.indexOf('prisma.$transaction'));
});

test('groups_join rejects private and full groups like REST joinGroup', () => {
  const block = caseBlock('groups_join');
  assert.match(block, /if \(group\.isPrivate\)/);
  assert.match(block, /reason: 'private_group_requires_invitation'/);
  assert.match(block, /group\.memberCount >= group\.maxMembers/);
  assert.match(block, /reason: 'group_full'/);
  assert.ok(block.indexOf('group.isPrivate') < block.indexOf('prisma.$transaction'));
  assert.ok(block.indexOf('group.maxMembers') < block.indexOf('prisma.$transaction'));
});

test('people_search and matching exclude blocked, banned and suspended users', () => {
  for (const name of ['people_search', 'matching_find_like_minded_peers']) {
    const block = caseBlock(name);
    assert.match(block, /AND: \[await getDiscoverableUsersWhere\(ctx\.userId\)\]/, name);
  }
});

test('nearby distance is only computed for users who share their location publicly', () => {
  const block = caseBlock('people_search');
  assert.match(block, /nearbyOnly &&\n\s+user\.shareLocationPublic === true &&/);
});

test('summarizeUser gates location on evaluateLocationVisibility and select includes the flag', () => {
  assert.match(tools, /shareLocationPublic: true,/);
  assert.match(tools, /location: evaluateLocationVisibility\(\{/);
  assert.match(tools, /isOwner: Boolean\(currentUser\) && currentUser\.id === user\.id/);
  assert.match(tools, /summarizeUser\(currentUser, currentUser\)/);
});

test('profile_get_user hides blocked or unavailable targets behind the not-found response', () => {
  const block = caseBlock('profile_get_user');
  assert.match(block, /await assertCanViewUser\(ctx\.userId, targetUserId\)/);
  assert.match(block, /err instanceof SafetyActionError/);
  assert.match(block, /reason: 'user_not_found'/);
  assert.ok(block.indexOf('assertCanViewUser') < block.indexOf('prisma.user.findUnique'));
});

test('posts_create_text enforces the post trust-tier limit before creating', () => {
  const block = caseBlock('posts_create_text');
  assert.match(block, /enforceTrustTierLimit\(ctx\.userId, 'post'\)/);
  assert.ok(block.indexOf('enforceTrustTierLimit') < block.indexOf('prisma.post.create'));
});
