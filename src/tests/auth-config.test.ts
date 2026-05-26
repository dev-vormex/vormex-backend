import assert from 'node:assert/strict';
import test from 'node:test';
import { findSensitivePublicEnvNames } from '../config/auth-security.config';
import { isWeakAuthSecret } from '../utils/jwt.util';

test('sensitive auth values are detected when placed in frontend-exposed env names', () => {
  assert.deepEqual(
    findSensitivePublicEnvNames({
      NEXT_PUBLIC_JWT_SECRET: 'bad',
      VITE_REFRESH_TOKEN: 'bad',
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: 'public-client-id',
      VITE_API_BASE_URL: 'https://api.example.test',
    }),
    ['NEXT_PUBLIC_JWT_SECRET', 'VITE_REFRESH_TOKEN']
  );
});

test('placeholder and repeated auth secrets are rejected as weak', () => {
  assert.equal(isWeakAuthSecret('replace-with-at-least-32-random-bytes'), true);
  assert.equal(isWeakAuthSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  assert.equal(isWeakAuthSecret('zV5mbk9S6n7rY8pL2qT4xC1dE3fG5hJ7'), false);
});
