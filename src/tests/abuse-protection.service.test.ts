import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getNormalizedApiPath,
  isHighConfidenceScannerUserAgent,
  isScriptLikeUserAgent,
  resolveGeneralApiRateLimitRules,
  resolveSensitiveActionRateLimitRules,
} from '../services/abuse-protection.service';
import type { AuthenticatedRequest } from '../types/auth.types';

function request(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    headers: {
      'user-agent': 'VormexAndroid/1.0.3 (com.vormex.android; Android 36)',
      ...overrides.headers,
    },
    ip: '203.0.113.10',
    method: 'GET',
    originalUrl: '/api/posts/feed?cursor=abc',
    socket: { remoteAddress: '203.0.113.10' },
    url: '/posts/feed?cursor=abc',
    ...overrides,
  } as AuthenticatedRequest;
}

test('normalizes mounted API paths without query strings', () => {
  assert.equal(getNormalizedApiPath(request()), '/api/posts/feed');
});

test('distinguishes known scanner user agents from the Android app user agent', () => {
  assert.equal(isScriptLikeUserAgent('VormexAndroid/1.0.3 (com.vormex.android; Android 36)'), false);
  assert.equal(isHighConfidenceScannerUserAgent('sqlmap/1.7'), true);
  assert.equal(isScriptLikeUserAgent('python-requests/2.32'), true);
});

test('anonymous read-heavy API requests receive scraping-specific buckets', () => {
  const rules = resolveGeneralApiRateLimitRules(
    request({
      headers: { 'user-agent': 'Mozilla/5.0' },
      originalUrl: '/api/people?limit=50',
      url: '/people?limit=50',
    })
  );

  assert.ok(rules.some((rule) => rule.keyPrefix === 'rate:ip:api:anonymous:read-heavy:sustained'));
  assert.ok(rules.some((rule) => rule.code === 'scrape_rate_limited'));
});

test('authenticated write API requests receive user write buckets', () => {
  const rules = resolveGeneralApiRateLimitRules(
    request({
      method: 'POST',
      originalUrl: '/api/posts',
      url: '/posts',
      user: { userId: 'user-1' },
    })
  );

  assert.ok(rules.some((rule) => rule.keyPrefix === 'rate:user:api:write'));
  assert.ok(rules.some((rule) => rule.keyPrefix === 'rate:user:api:sustained'));
});

test('payment actions use sensitive user and IP buckets', () => {
  const rules = resolveSensitiveActionRateLimitRules(
    request({
      method: 'POST',
      originalUrl: '/api/premium/checkout',
      user: { userId: 'user-1' },
    }),
    'payment'
  );

  assert.deepEqual(
    rules.map((rule) => rule.keyPrefix),
    [
      'rate:ip:sensitive:payment:burst',
      'rate:user:sensitive:payment:burst',
      'rate:ip:sensitive:payment:sustained',
      'rate:user:sensitive:payment:sustained',
    ]
  );
});
