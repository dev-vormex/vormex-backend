import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRequestInput } from '../middleware/input-validation.middleware';
import { sanitizeInputTree } from '../utils/input-security.util';

test('URL fields reject localhost unless explicitly allowed', () => {
  const defaultResult = sanitizeInputTree(
    { redirectUri: 'http://localhost:3000/auth/google/callback' },
    { location: 'body' },
  );

  assert.equal(defaultResult.ok, false);
  assert.equal(defaultResult.error, 'URL host is not allowed');

  const oauthResult = sanitizeInputTree(
    { redirectUri: 'http://localhost:3000/auth/google/callback' },
    { location: 'body', allowLocalhostUrls: true },
  );

  assert.equal(oauthResult.ok, true);
});

function validateBody(path: string) {
  const req = {
    method: 'POST',
    path,
    originalUrl: `/api${path}`,
    query: {},
    body: {
      redirectUri: 'http://localhost:3000/auth/google/callback',
    },
  };
  const res = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;

  validateRequestInput(req as any, res as any, () => {
    nextCalled = true;
  });

  return { nextCalled, res };
}

test('Google code exchange route allows localhost redirect URI through middleware', () => {
  const result = validateBody('/auth/google/code');

  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, 200);
});

test('other routes still reject localhost URL fields through middleware', () => {
  const result = validateBody('/profile');

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 400);
  assert.deepEqual(result.res.payload, {
    error: 'Invalid request input',
    message: 'URL host is not allowed',
  });
});
