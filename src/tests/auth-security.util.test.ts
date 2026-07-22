import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateOpaqueToken,
  getPasswordMinLength,
  hashOpaqueToken,
  isLikelyOpaqueToken,
  passwordHashNeedsRehash,
  validatePasswordStrength,
  verifyOpaqueToken,
} from '../utils/auth-security.util';

test('password policy accepts secure six-character passwords', () => {
  const previousMinLength = process.env.AUTH_PASSWORD_MIN_LENGTH;
  delete process.env.AUTH_PASSWORD_MIN_LENGTH;

  try {
    assert.equal(getPasswordMinLength(), 6);
    assert.equal(validatePasswordStrength('Ab1!xy'), null);
    assert.match(validatePasswordStrength('A1!xy') || '', /at least 6 characters/);
    assert.match(validatePasswordStrength('abcdef') || '', /at least three/);
  } finally {
    if (previousMinLength === undefined) {
      delete process.env.AUTH_PASSWORD_MIN_LENGTH;
    } else {
      process.env.AUTH_PASSWORD_MIN_LENGTH = previousMinLength;
    }
  }
});

test('opaque tokens are random-looking and stored as deterministic SHA-256 hashes', () => {
  const token = generateOpaqueToken();
  const hash = hashOpaqueToken(token);

  assert.equal(isLikelyOpaqueToken(token), true);
  assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(verifyOpaqueToken(token, hash), true);
  assert.equal(verifyOpaqueToken(`${token}x`, hash), false);
});

test('password hash rehash detection flags weak bcrypt cost factors', () => {
  assert.equal(
    passwordHashNeedsRehash('$2a$10$MIXrVGH.t/zvwOmhTCzyz.EMEyaV6xUjo8ULpCRkDEvR4qiK/eGDq'),
    true
  );
  assert.equal(
    passwordHashNeedsRehash('$2a$12$MIXrVGH.t/zvwOmhTCzyz.EMEyaV6xUjo8ULpCRkDEvR4qiK/eGDq'),
    false
  );
});
