import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRequestInput } from '../shared/middleware/input-validation.middleware';
import { sanitizeInputTree } from '../shared/utils/input-security.util';

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

/*
 * Pagination cursors are base64url, which legitimately produces runs like "--".
 * Treating them as 'structural' made the SQL-comment rule reject roughly 1 in
 * 170 signed cursors, breaking infinite scroll intermittently with an error
 * that pointed nowhere near the cause.
 */
test('signed base64url pagination cursors survive query sanitisation', () => {
  const cursorsWithSqlCommentRun = [
    'eyJ2IjoxLCJzaWQiOiJhLS1iIn0.c2ln--bmF0dXJl',
    'eyJ2IjoxfQ.abc--def_ghi-jkl',
    'rec:root:20:m4x9k2',
  ];

  for (const cursor of cursorsWithSqlCommentRun) {
    const result = sanitizeInputTree({ cursor }, { location: 'query', maxStringLength: 512 });
    assert.equal(result.ok, true, `cursor rejected: ${cursor} (${result.error})`);
    assert.deepEqual(result.value, { cursor });
  }
});

test('cursors are still held to a strict opaque-token alphabet', () => {
  for (const cursor of [
    "abc' OR '1'='1",
    'abc<script>alert(1)</script>',
    'abc;DROP TABLE posts',
    'abc|whoami',
    'abc def',
    'abc`id`',
  ]) {
    const result = sanitizeInputTree({ cursor }, { location: 'query', maxStringLength: 512 });
    assert.equal(result.ok, false, `unsafe cursor accepted: ${cursor}`);
  }
});

test('non-cursor structural query params keep the injection rules', () => {
  const result = sanitizeInputTree(
    { postId: "1' UNION SELECT * FROM users --" },
    { location: 'query', maxStringLength: 512 },
  );

  assert.equal(result.ok, false);
});
