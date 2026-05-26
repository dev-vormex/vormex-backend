import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isLikelyOpaqueToken,
  passwordHashNeedsRehash,
  verifyOpaqueToken,
} from '../utils/auth-security.util';

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
