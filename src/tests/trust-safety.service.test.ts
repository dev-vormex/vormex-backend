import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maskEmail,
  maskPhone,
  hashDeviceInstallCode,
  normalizeDeviceInstallId,
  normalizeDevicePlatform,
  normalizePhoneE164,
  publicTrustFields,
  trustLevelRank,
  verificationBadgesForTrustLevel,
} from '../services/trust-safety.service';

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
