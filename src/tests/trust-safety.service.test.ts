import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  maskEmail,
  maskPhone,
  hashDeviceInstallCode,
  normalizeDeviceInstallId,
  normalizeDevicePlatform,
  normalizePhoneE164,
  publicTrustFields,
  SafetyActionError,
  safetyErrorResponse,
  trustLevelRank,
  verificationBadgesForTrustLevel,
} from '../services/trust-safety.service';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

test('classifies block enforcement errors as terminal structured failures', () => {
  const blocked = new SafetyActionError('This action is unavailable', 'user_blocked', 403);
  const unavailable = new SafetyActionError('Resource unavailable', 'resource_unavailable', 404);

  assert.deepEqual(safetyErrorResponse(blocked), {
    statusCode: 403,
    body: {
      error: 'This action is unavailable',
      code: 'user_blocked',
      retryable: false,
      retryAfterSeconds: undefined,
    },
  });
  assert.equal(safetyErrorResponse(unavailable).body.retryable, false);
});

test('normalizes E.164 phone numbers and rejects invalid values', () => {
  assert.equal(normalizePhoneE164('+1 (555) 123-4567'), '+15551234567');
  assert.equal(normalizePhoneE164('5551234567'), null);
  assert.equal(normalizePhoneE164('+0123456789'), null);
});

test('masks phone and student email without exposing raw values', () => {
  assert.equal(maskPhone('+15551234567'), '•••• 4567');
  assert.equal(maskEmail('student@example.edu'), 'st••@example.edu');
});

test('orders trust tiers and maps public badges', () => {
  assert.ok(trustLevelRank('ID_VERIFIED') > trustLevelRank('PHONE_VERIFIED'));
  assert.deepEqual(verificationBadgesForTrustLevel('STUDENT_VERIFIED'), [
    'email',
    'phone',
    'student',
  ]);
  assert.deepEqual(publicTrustFields('not-a-tier'), {
    identityTrustLevel: 'BASIC',
    verificationBadges: [],
  });
});

test('normalizes and hashes install codes without exposing raw values', () => {
  const installId = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(normalizeDeviceInstallId(installId), installId);
  assert.equal(normalizeDeviceInstallId('short'), null);
  assert.equal(normalizeDevicePlatform('Android'), 'android');
  assert.equal(normalizeDevicePlatform('../bad'), 'unknown');

  const androidHash = hashDeviceInstallCode(installId, 'android');
  const webHash = hashDeviceInstallCode(installId, 'web');
  assert.match(androidHash, /^[a-f0-9]{64}$/);
  assert.notEqual(androidHash, installId);
  assert.notEqual(androidHash, webHash);
});

test('profile reads enforce bilateral blocks before cached profile service reads', () => {
  const controller = source('src/controllers/profile.controller.ts');
  const getProfile = controller.slice(
    controller.indexOf('export const getProfile ='),
    controller.indexOf('export const getProfileSections =')
  );

  const guardIndex = getProfile.indexOf('isProfileUnavailable(requestingUserId, userId)');
  const coreReadIndex = getProfile.indexOf('profileService.getCoreProfile');
  const fullReadIndex = getProfile.indexOf('profileService.getFullProfile');

  assert.ok(guardIndex >= 0, 'main profile endpoint must enforce the bilateral block boundary');
  assert.ok(guardIndex < coreReadIndex, 'block authorization must happen before the core profile cache path');
  assert.ok(guardIndex < fullReadIndex, 'block authorization must happen before the full profile cache path');
  assert.match(getProfile, /sendResourceUnavailable\(res\)/);
});

test('story interaction denials use privacy-safe terminal errors', () => {
  const controller = source('src/controllers/stories.controller.ts');
  const react = controller.slice(
    controller.indexOf('export const reactToStory ='),
    controller.indexOf('export const removeStoryReaction =')
  );
  const reply = controller.slice(
    controller.indexOf('export const replyToStory ='),
    controller.indexOf('export const getStoryAnalytics =')
  );

  assert.match(controller, /code: 'resource_unavailable'/);
  assert.match(controller, /retryable: false/);
  assert.match(react, /sendStoryUnavailable\(res\)/);
  assert.match(reply, /sendStoryUnavailable\(res\)/);
});

test('block cleanup stays bounded for device-linked accounts', () => {
  const service = source('src/services/trust-safety.service.ts');
  const blockOperation = service.slice(
    service.indexOf('export async function createUserBlockWithDeviceScope'),
    service.indexOf('export async function findBlockBetween')
  );

  assert.match(blockOperation, /user_block_device_scopes\.createMany/);
  assert.match(blockOperation, /skipDuplicates: true/);
  assert.match(blockOperation, /connectionsToDelete\.flatMap/);
  assert.match(blockOperation, /followsToDelete\.flatMap/);
  assert.match(blockOperation, /maxWait: 10_000/);
  assert.match(blockOperation, /timeout: 30_000/);
});
