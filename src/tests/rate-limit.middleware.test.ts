import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Response } from 'express';
import type { Socket } from 'node:net';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import type { RateLimitRule, RateLimitResult } from '../services/rate-limit.service';
import type { AuthenticatedRequest } from '../types/auth.types';
import { register } from '../infrastructure/metrics/registry';

type TestResponse = Response & {
  body?: unknown;
  headers: Record<string, string>;
  statusCode: number;
};

function buildRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    headers: {
      'user-agent': 'VormexAndroid/1.0.3',
      ...overrides.headers,
    },
    ip: '203.0.113.44',
    method: 'POST',
    originalUrl: '/api/auth/login',
    requestId: 'test-request',
    socket: { remoteAddress: '203.0.113.44' },
    url: '/api/auth/login',
    ...overrides,
  } as AuthenticatedRequest;
}

function buildResponse(): TestResponse {
  const response = {
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    statusCode: 200,
    setHeader(name: string, value: number | string) {
      this.headers[name.toLowerCase()] = String(value);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as TestResponse;
}

function testSocket(remoteAddress: string): Socket {
  return { remoteAddress } as Socket;
}

function redisDownEvaluator(): Promise<RateLimitResult> {
  return Promise.reject(new Error('redis down'));
}

async function runMiddleware(params: {
  req: AuthenticatedRequest;
  rules: RateLimitRule[];
}): Promise<{ nextCalled: boolean; res: TestResponse }> {
  const res = buildResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  const middleware = createRateLimitMiddleware(() => params.rules, {
    evaluate: redisDownEvaluator,
  });

  await middleware(params.req, res, next);

  return { nextCalled, res };
}

test('sensitive routes use an emergency limiter when Redis is down', async () => {
  const keySuffix = `auth:login:${Date.now()}`;
  const rule: RateLimitRule = {
    keyPrefix: `rate:ip:${keySuffix}`,
    limit: 50,
    emergencyLimit: 2,
    emergencyWindowSeconds: 60,
    windowSeconds: 60,
    code: 'login_rate_limited',
    message: 'Too many login attempts. Please wait before trying again.',
  };
  const req = buildRequest({
    ip: '203.0.113.45',
    originalUrl: '/api/auth/login',
    socket: testSocket('203.0.113.45'),
    url: '/api/auth/login',
  });

  const first = await runMiddleware({ req, rules: [rule] });
  const second = await runMiddleware({ req, rules: [rule] });
  const third = await runMiddleware({ req, rules: [rule] });

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, true);
  assert.equal(third.nextCalled, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.headers['x-ratelimit-limit'], '2');
  assert.equal(third.res.headers['retry-after'] !== undefined, true);
  assert.deepEqual(third.res.body, {
    error: 'Too many login attempts. Please wait before trying again.',
    code: 'login_rate_limited',
    requestId: 'test-request',
    retryAfterSeconds: Number(third.res.headers['retry-after']),
  });
});

test('sensitive path traffic is protected even when the rule key is generic', async () => {
  const rule: RateLimitRule = {
    keyPrefix: `rate:ip:api:burst:${Date.now()}`,
    limit: 120,
    emergencyLimit: 1,
    emergencyWindowSeconds: 60,
    windowSeconds: 60,
  };
  const req = buildRequest({
    ip: '203.0.113.46',
    method: 'GET',
    originalUrl: '/api/search?q=student',
    socket: testSocket('203.0.113.46'),
    url: '/api/search?q=student',
  });

  const first = await runMiddleware({ req, rules: [rule] });
  const second = await runMiddleware({ req, rules: [rule] });

  assert.equal(first.nextCalled, true);
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 429);
});

test('non-sensitive routes keep the fail-open policy when Redis is down', async () => {
  const req = buildRequest({
    ip: '203.0.113.47',
    method: 'GET',
    originalUrl: '/api/feed',
    socket: testSocket('203.0.113.47'),
    url: '/api/feed',
  });
  const rule: RateLimitRule = {
    keyPrefix: `rate:ip:api:read:${Date.now()}`,
    limit: 120,
    windowSeconds: 60,
  };

  const result = await runMiddleware({ req, rules: [rule] });

  assert.equal(result.nextCalled, true);
  assert.equal(result.res.statusCode, 200);
});

test('emergency limiter increments Prometheus degradation metrics', async () => {
  const metrics = await register.metrics();

  assert.match(metrics, /vormex_rate_limit_emergency_total/);
});
