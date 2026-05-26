import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldReturnAuthTokensInBody } from '../services/auth-transport.service';

test('browser auth responses never include bearer or refresh tokens in the body', () => {
  assert.equal(
    shouldReturnAuthTokensInBody({
      headers: {
        origin: 'http://localhost:3000',
        'x-auth-token-transport': 'bearer',
      },
    } as any),
    false
  );
});

test('non-browser auth responses require an explicit bearer transport opt-in', () => {
  assert.equal(shouldReturnAuthTokensInBody({ headers: {} } as any), false);
  assert.equal(
    shouldReturnAuthTokensInBody({
      headers: { 'x-auth-token-transport': 'bearer' },
    } as any),
    true
  );
});
