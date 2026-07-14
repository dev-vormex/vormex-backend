import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateSocketTicket,
  getSocketTicketTtlSeconds,
  verifyToken,
} from '../utils/jwt.util';
import { verifyAccessToken } from '../middleware/auth.middleware';

test('socket tickets are short-lived, purpose-bound, and rejected as REST access tokens', async () => {
  const previousSecret = process.env.JWT_SECRET;
  const previousTtl = process.env.SOCKET_TICKET_TTL_SECONDS;
  process.env.JWT_SECRET = 'socket-ticket-test-secret-with-at-least-32-characters';
  process.env.SOCKET_TICKET_TTL_SECONDS = '90';

  try {
    const before = Math.floor(Date.now() / 1000);
    const ticket = generateSocketTicket('user-1', 'session-1');
    const payload = verifyToken(ticket);

    assert.equal(payload.userId, 'user-1');
    assert.equal(payload.sessionId, 'session-1');
    assert.equal(payload.purpose, 'socket');
    assert.ok(payload.exp);
    assert.ok(payload.iat);
    assert.ok((payload.exp ?? 0) - before <= getSocketTicketTtlSeconds() + 1);
    await assert.rejects(() => verifyAccessToken(ticket), /Invalid token purpose/);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (previousTtl === undefined) delete process.env.SOCKET_TICKET_TTL_SECONDS;
    else process.env.SOCKET_TICKET_TTL_SECONDS = previousTtl;
  }
});
