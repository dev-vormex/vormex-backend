import { assertSourceImports } from './helpers/implementation-source';
import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function methodBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  async ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const next = text.indexOf('\n  async ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

const notificationSource = source('src/modules/notifications/services/notification.service.ts');

const gatedNotifiers = [
  'notifyMention',
  'notifyPostCollabInvite',
  'notifyReelComment',
  'notifyReelCommentReply',
  'notifyHackathonTeamMatch',
  'notifyHackathonTeamApplication',
  'notifyHackathonTeamApplicationAccepted',
  'notifySkillEndorsement',
  'notifySkillSwapRequest',
  'notifySkillSwapAccepted',
  'notifySkillSwapCompleted',
  'notifyCollegeCommunityJoined',
];

for (const name of gatedNotifiers) {
  test(`${name} skips the push when createNotification rejects the actor`, () => {
    const block = methodBlock(notificationSource, name);
    const create = block.indexOf('const notificationCreated = await this.createNotification(');
    const gate = block.indexOf('if (!notificationCreated) return;');
    const push = block.indexOf('pushNotificationService.sendToUser(');
    assert.ok(create !== -1, 'result of createNotification must be captured');
    assert.ok(gate > create, 'gate must follow createNotification');
    assert.ok(push > gate, 'push must come after the gate');
  });
}

test('notifyNewHackathonMatch only gates the push when an actor is present', () => {
  const block = methodBlock(notificationSource, 'notifyNewHackathonMatch');
  const create = block.indexOf('const notificationCreated = await this.createNotification(');
  const gate = block.indexOf('if (params.actorId && !notificationCreated) return;');
  const push = block.indexOf('pushNotificationService.sendToUser(');
  assert.ok(create !== -1 && gate > create && push > gate);
});

test('system notifications without an actor are not gated', () => {
  for (const name of ['notifyHackathonWeeklyDigest', 'notifyStreakMilestone', 'notifyXpEarned']) {
    assert.doesNotMatch(methodBlock(notificationSource, name), /notificationCreated/);
  }
});

test('createNotification still refuses self and blocked actors', () => {
  const block = methodBlock(notificationSource, 'createNotification');
  assert.match(block, /actorId === userId/);
  assert.match(block, /areUsersBlocked\(actorId, userId\)/);
});

test('google sign-in rejects suspended accounts in both lookup paths before a session is created', () => {
  const text = source('src/modules/auth/controllers/oauth.controller.ts');
  const start = text.indexOf('export const googleSignIn =');
  const end = text.indexOf('export const googleCodeSignIn =');
  assert.ok(start !== -1 && end > start);
  const block = text.slice(start, end);

  // googleId path + email path + the two update selects
  assert.equal((block.match(/safetySuspendedUntil: true/g) || []).length, 4);

  const suspendedGate = /\.safetySuspendedUntil && (\w+)\.safetySuspendedUntil > new Date\(\)/g;
  const gates = [...block.matchAll(suspendedGate)];
  assert.equal(gates.length, 2);

  const firstSession = block.indexOf('createOAuthSession(');
  const secondSession = block.indexOf('createOAuthSession(', firstSession + 1);
  assert.ok(gates[0].index! < firstSession, 'googleId path must check before session');
  assert.ok(gates[1].index! > firstSession && gates[1].index! < secondSession, 'email path must check before its session');

  assert.match(block, /error: 'User account is temporarily suspended',\s*code: 'account_suspended',\s*suspendedUntil: user\.safetySuspendedUntil\.toISOString\(\)/);
  assert.match(block, /code: 'account_suspended',\s*suspendedUntil: existingUserByEmail\.safetySuspendedUntil\.toISOString\(\)/);
});

test('google suspension response matches password login', () => {
  const auth = source('src/modules/auth/controllers/auth.controller.ts');
  assert.match(auth, /error: 'User account is temporarily suspended',\s*code: 'account_suspended',\s*suspendedUntil: user\.safetySuspendedUntil\.toISOString\(\)/);
});

test('report-driven ban and restrict invalidate proximity like the direct admin paths', () => {
  const text = source('src/modules/admin/controllers/admin.controller.ts');
  const start = text.indexOf('export const takeReportAction =');
  assert.ok(start !== -1);
  const next = text.indexOf('\nexport const ', start + 1);
  const block = next === -1 ? text.slice(start) : text.slice(start, next);

  const postTx = block.slice(block.indexOf('if (affectedUserId) {'));
  assert.match(postTx, /normalizedAction === 'USER_BANNED'\) \{\s*await invalidateUserProximity\(affectedUserId, 'admin_ban'\)/);
  assert.match(postTx, /normalizedAction === 'USER_RESTRICTED'\) \{\s*await invalidateUserProximity\(affectedUserId, 'safety_restricted'\)/);
  assert.doesNotMatch(postTx, /USER_SUSPENDED/);

  // reasons match the direct paths
  assert.match(text, /invalidateUserProximity\(id, 'admin_ban'\)/);
  assert.match(text, /invalidateUserProximity\(id, 'safety_restricted'\)/);
  assertSourceImports(text, "proximity/services/proximity-privacy.service", ["invalidateUserProximity"]);
});
