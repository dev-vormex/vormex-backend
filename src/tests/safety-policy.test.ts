import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverableUsersWhere,
  evaluateAccountMayAct,
  evaluateDiscoveryCandidate,
  evaluateInteraction,
  evaluateLocationVisibility,
  evaluateNotificationRecipient,
  evaluateProfileVisibility,
  isActiveUntil,
} from '../modules/safety/services/safety-policy';
import { safetyDenialToError, SafetyActionError, safetyErrorResponse } from '../modules/safety/services/trust-safety.service';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const future = new Date(NOW.getTime() + 60_000);
const past = new Date(NOW.getTime() - 60_000);
const normal = { isBanned: false, safetySuspendedUntil: null, safetyRestrictedUntil: null };

const facts = (over: Record<string, unknown> = {}) => ({
  actorId: 'a',
  targetId: 'b',
  actor: normal,
  target: normal,
  blocked: false,
  ...over,
});

test('normal user -> normal user interaction is allowed', () => {
  assert.equal(evaluateInteraction(facts(), NOW).allowed, true);
});

test('block in either direction denies interaction with BLOCKED', () => {
  // The `blocked` fact is direction-agnostic: getBlockedUserIds/findBlockBetween already merge both directions.
  const decision = evaluateInteraction(facts({ blocked: true }), NOW);
  assert.deepEqual(decision, { allowed: false, reason: 'BLOCKED' });
  const reverse = evaluateInteraction(facts({ actorId: 'b', targetId: 'a', blocked: true }), NOW);
  assert.deepEqual(reverse, { allowed: false, reason: 'BLOCKED' });
});

test('self interaction is never denied', () => {
  assert.equal(evaluateInteraction(facts({ targetId: 'a', blocked: true, actor: { isBanned: true } }), NOW).allowed, true);
  assert.equal(evaluateProfileVisibility({ viewerId: 'a', targetId: 'a', target: { isBanned: true }, blocked: true }, NOW).allowed, true);
});

test('banned actor is denied before anything else', () => {
  const decision = evaluateInteraction(
    facts({ actor: { isBanned: true, safetySuspendedUntil: future }, blocked: true, target: { isBanned: true } }),
    NOW
  );
  assert.deepEqual(decision, { allowed: false, reason: 'ACCOUNT_BANNED' });
});

test('temporarily suspended actor is denied; expired suspension is not', () => {
  assert.equal(evaluateInteraction(facts({ actor: { safetySuspendedUntil: future } }), NOW).reason, 'ACCOUNT_SUSPENDED');
  assert.equal(evaluateInteraction(facts({ actor: { safetySuspendedUntil: past } }), NOW).allowed, true);
  assert.equal(evaluateInteraction(facts({ actor: { safetySuspendedUntil: NOW } }), NOW).allowed, true);
});

test('restricted (trust-tier safety) actor is denied; expired restriction is not', () => {
  assert.equal(evaluateInteraction(facts({ actor: { safetyRestrictedUntil: future } }), NOW).reason, 'ACCOUNT_RESTRICTED');
  assert.equal(evaluateInteraction(facts({ actor: { safetyRestrictedUntil: past } }), NOW).allowed, true);
  // Restriction is only for social actions: it does not stop an account from existing.
  assert.equal(evaluateAccountMayAct({ safetyRestrictedUntil: future }, { now: NOW, includeRestricted: false }).allowed, true);
});

test('banned or suspended target is unavailable, not "blocked"', () => {
  assert.equal(evaluateInteraction(facts({ target: { isBanned: true } }), NOW).reason, 'TARGET_UNAVAILABLE');
  assert.equal(evaluateInteraction(facts({ target: { safetySuspendedUntil: future } }), NOW).reason, 'TARGET_UNAVAILABLE');
  assert.equal(evaluateInteraction(facts({ target: { safetySuspendedUntil: past } }), NOW).allowed, true);
  // target unavailability outranks a block so a block is never revealed for unavailable users
  assert.equal(evaluateInteraction(facts({ target: { isBanned: true }, blocked: true }), NOW).reason, 'TARGET_UNAVAILABLE');
});

test('missing account records impose no restriction (legacy behavior)', () => {
  assert.equal(evaluateInteraction({ actorId: 'a', targetId: 'b', actor: null, target: null, blocked: false }, NOW).allowed, true);
});

test('suspension timestamps accept ISO strings and ignore invalid values', () => {
  assert.equal(isActiveUntil(future.toISOString(), NOW), true);
  assert.equal(isActiveUntil('not-a-date', NOW), false);
  assert.equal(isActiveUntil(null, NOW), false);
});

test('viewing and interacting are separate questions', () => {
  // A restricted viewer can still see a profile, but cannot interact with it.
  const viewer = { safetyRestrictedUntil: future };
  assert.equal(evaluateProfileVisibility({ viewerId: 'a', targetId: 'b', target: normal, blocked: false }, NOW).allowed, true);
  assert.equal(evaluateInteraction(facts({ actor: viewer }), NOW).reason, 'ACCOUNT_RESTRICTED');
  // A blocked pair can neither view nor interact.
  assert.equal(evaluateProfileVisibility({ viewerId: 'a', targetId: 'b', target: normal, blocked: true }, NOW).reason, 'BLOCKED');
  assert.equal(evaluateProfileVisibility({ viewerId: 'a', targetId: 'b', target: { isBanned: true }, blocked: false }, NOW).reason, 'TARGET_UNAVAILABLE');
});

test('discovery excludes self, banned, suspended and blocked candidates', () => {
  const base = { viewerId: 'a', candidateId: 'b', candidate: normal, blockedUserIds: new Set<string>() };
  assert.equal(evaluateDiscoveryCandidate(base, NOW).allowed, true);
  assert.equal(evaluateDiscoveryCandidate({ ...base, candidateId: 'a' }, NOW).allowed, false);
  assert.equal(evaluateDiscoveryCandidate({ ...base, candidate: { isBanned: true } }, NOW).reason, 'TARGET_UNAVAILABLE');
  assert.equal(evaluateDiscoveryCandidate({ ...base, candidate: { safetySuspendedUntil: future } }, NOW).reason, 'TARGET_UNAVAILABLE');
  assert.equal(evaluateDiscoveryCandidate({ ...base, candidate: { safetySuspendedUntil: past } }, NOW).allowed, true);
  assert.equal(evaluateDiscoveryCandidate({ ...base, blockedUserIds: ['b'] }, NOW).reason, 'BLOCKED');
});

test('discoverableUsersWhere builds the prisma fragment matching the discovery rule', () => {
  const where = discoverableUsersWhere('a', ['x', 'y', 'x', ''], NOW);
  assert.equal(where.isBanned, false);
  assert.deepEqual(where.id.notIn, ['a', 'x', 'y']);
  assert.deepEqual(where.OR, [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lte: NOW } }]);
});

test('notifications are suppressed for self and across blocks', () => {
  assert.equal(evaluateNotificationRecipient({ actorId: 'a', recipientId: 'b', blocked: false }).allowed, true);
  assert.equal(evaluateNotificationRecipient({ actorId: 'a', recipientId: 'a', blocked: false }).allowed, false);
  assert.equal(evaluateNotificationRecipient({ actorId: 'a', recipientId: 'b', blocked: true }).reason, 'BLOCKED');
});

test('location is visible to the owner or when the target opted in, never by default', () => {
  assert.equal(evaluateLocationVisibility({ isOwner: true, shareLocationPublic: false }), true);
  assert.equal(evaluateLocationVisibility({ isOwner: false, shareLocationPublic: true }), true);
  assert.equal(evaluateLocationVisibility({ isOwner: false, shareLocationPublic: false }), false);
  assert.equal(evaluateLocationVisibility({ isOwner: false, shareLocationPublic: null }), false);
  assert.equal(evaluateLocationVisibility({ isOwner: false }), false);
});

test('denial reasons map to the legacy SafetyActionError codes, messages and statuses', () => {
  const cases: Array<[Parameters<typeof safetyDenialToError>[0], string, number, string]> = [
    ['ACCOUNT_BANNED', 'account_banned', 403, 'Your account is banned.'],
    ['ACCOUNT_SUSPENDED', 'account_suspended', 403, 'Your account is temporarily suspended.'],
    ['ACCOUNT_RESTRICTED', 'safety_restricted', 403, 'This action is temporarily restricted.'],
    ['TARGET_UNAVAILABLE', 'target_unavailable', 404, 'This user is not available right now.'],
    ['BLOCKED', 'user_blocked', 403, 'This message is blocked by your safety settings.'],
  ];
  for (const [reason, code, status, message] of cases) {
    const error = safetyDenialToError(reason, 'message');
    assert.ok(error instanceof SafetyActionError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    assert.equal(error.message, message);
  }
  const response = safetyErrorResponse(safetyDenialToError('BLOCKED', 'message'));
  assert.ok(response);
  assert.equal(response.body.retryable, false);
});

test('policy module stays transport-free', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(process.cwd(), 'src/modules/safety/services/safety-policy.ts'), 'utf8');
  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /statusCode|res\.status/);
});
