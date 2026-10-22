/**
 * Guards the per-request round-trip budget.
 *
 * Every authenticated API call used to pay ten sequential Redis latencies before
 * routing: two for auth, seven for rate limiting, one for the feed cache probe.
 * These tests exist so that budget cannot silently regress — the failure mode is
 * invisible locally (Redis is a millisecond away) and severe in production.
 */

import assert from 'node:assert/strict';
import { readImplementationFile as readFileSync } from './helpers/implementation-source';
import { join } from 'node:path';
import test from 'node:test';
import {
  evaluateRateLimits,
  type RateLimitRule,
} from '../infrastructure/security/rate-limit.service';
import {
  getFreshLocalAuthUserStatus,
  getLocalAuthUserStatus,
  invalidateAuthUserStatus,
  setLocalAuthUserStatus,
} from '../modules/auth/services/auth-user-status-cache.service';
import { resolveGeneralApiRateLimitRules } from '../infrastructure/security/abuse-protection.service';
import type { AuthenticatedRequest } from '../modules/auth/types/auth.types';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function feedRequest(userId: string | null): AuthenticatedRequest {
  return {
    headers: { 'user-agent': 'VormexAndroid/1.0.8' },
    ip: '203.0.113.10',
    method: 'GET',
    originalUrl: '/api/posts/feed?limit=20',
    socket: { remoteAddress: '203.0.113.10' },
    url: '/api/posts/feed?limit=20',
    ...(userId ? { user: { userId } } : {}),
  } as AuthenticatedRequest;
}

test('an authenticated feed read still resolves many rules, and they are batched', async () => {
  const rules = resolveGeneralApiRateLimitRules(feedRequest('user-1'));

  // The count is the point: this is how many serial Redis calls the old loop made.
  assert.ok(
    rules.length >= 7,
    `expected the read-heavy authenticated path to carry >= 7 rules, got ${rules.length}`
  );

  const middleware = source('src/shared/middleware/rate-limit.middleware.ts');
  // One call covering every rule, not one call per rule inside the loop.
  assert.match(middleware, /evaluateRateLimits\(/);
  assert.doesNotMatch(middleware, /for \(const rule of rules\)[\s\S]*await evaluate\(/);
});

test('the batched limiter returns one positional result per rule', async () => {
  const suffix = `budget-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const rules: RateLimitRule[] = [
    { keyPrefix: `rate:ip:${suffix}:a`, limit: 5, windowSeconds: 60 },
    { keyPrefix: `rate:ip:${suffix}:b`, limit: 1, windowSeconds: 60 },
    { keyPrefix: `rate:ip:${suffix}:c`, limit: 5, windowSeconds: 60 },
  ];

  // With no Redis configured in tests this degrades to the in-memory limiter,
  // which is exactly the fallback the middleware depends on.
  const first = await evaluateRateLimits(
    rules.map((rule) => ({ identifier: '203.0.113.11', rule }))
  );
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((entry) => entry.allowed), [true, true, true]);
  assert.deepEqual(first.map((entry) => entry.limit), [5, 1, 5]);

  const second = await evaluateRateLimits(
    rules.map((rule) => ({ identifier: '203.0.113.11', rule }))
  );
  // Only the rule with limit 1 trips, and it trips in its own position.
  assert.deepEqual(second.map((entry) => entry.allowed), [true, false, true]);
});

test('the batch script is registered once per client rather than shipped per call', () => {
  const service = source('src/infrastructure/security/rate-limit.service.ts');

  assert.match(service, /defineCommand\(SLIDING_WINDOW_COMMAND/);
  assert.match(service, /WeakSet<Redis>/);
  // The old path sent the Lua body with every single evaluation.
  assert.doesNotMatch(service, /client\.eval\(\s*SLIDING_WINDOW/);
});

test('a fresh local auth status answers without reaching Redis', async () => {
  const userId = `budget-user-${process.pid}`;
  await invalidateAuthUserStatus(userId);
  assert.equal(getFreshLocalAuthUserStatus(userId), null);

  setLocalAuthUserStatus(userId, true);
  assert.equal(getFreshLocalAuthUserStatus(userId), true);

  await invalidateAuthUserStatus(userId);
  assert.equal(getFreshLocalAuthUserStatus(userId), null);
  assert.equal(getLocalAuthUserStatus(userId), null);
});

test('the local status cache is consulted before Redis, not only as an outage fallback', () => {
  const cache = source('src/modules/auth/services/auth-user-status-cache.service.ts');
  const getter = cache.slice(
    cache.indexOf('export async function getCachedAuthUserStatus'),
    cache.indexOf('export async function setCachedAuthUserStatus')
  );

  // The local read must come before the Redis read, or every request pays a hop.
  const localIndex = getter.indexOf('getFreshLocalAuthUserStatus');
  const redisIndex = getter.indexOf('redisCommand.get');
  assert.notEqual(localIndex, -1);
  assert.notEqual(redisIndex, -1);
  assert.ok(localIndex < redisIndex, 'local cache must be read before Redis');

  // Two windows: a short trusted one and the longer outage fallback.
  assert.match(cache, /freshUntil/);
  assert.match(cache, /fallbackUntil/);
});

test('session and account status resolve in a single pipelined read', () => {
  const gate = source('src/modules/auth/services/auth-gate.service.ts');
  const middleware = source('src/shared/middleware/auth.middleware.ts');

  assert.match(gate, /client\.mget\(\.\.\.keys\)/);
  // Both gate inputs go into the same key list.
  assert.match(gate, /keys\.push\(authSessionRedisKey/);
  assert.match(gate, /keys\.push\(authUserStatusCacheKey/);

  // The middleware must not have grown its own sequential awaits back.
  assert.doesNotMatch(middleware, /await getAuthSession\(/);
  assert.doesNotMatch(middleware, /await getCachedAuthUserStatus\(/);
  assert.equal((middleware.match(/evaluateAuthGate\(/g) || []).length, 1);
});

test('a cached denial keeps its original client-facing error code', () => {
  const gate = source('src/modules/auth/services/auth-gate.service.ts');

  // auth.middleware.ts substring-matches this to pick `auth_not_allowed`.
  assert.match(gate, /'User account is disabled or email verification required'/);
  assert.match(gate, /user_denied_cached/);
});

test('revocation stays immediate despite the local status window', () => {
  const admin = source('src/modules/admin/controllers/admin.controller.ts');

  // The short local status window is only safe because every restrictive action
  // also kills the session, and sessions are read from Redis on every request.
  // Anchored on the safety-event type, which appears once per handler.
  for (const eventType of ["eventType: 'USER_BANNED'", "eventType: 'USER_SUSPENDED'"]) {
    const at = admin.indexOf(eventType);
    assert.notEqual(at, -1, `${eventType} not found`);
    const following = admin.slice(at, at + 600);
    assert.match(
      following,
      /revokeAllAuthSessions\(/,
      `${eventType} must revoke sessions, not rely on the status cache alone`
    );
  }
});

test('post images are downscaled and uploaded concurrently', () => {
  const controller = source('src/modules/content/controllers/post.controller.ts');
  const images = source('src/infrastructure/media/image-processing.service.ts');

  assert.match(controller, /imageProcessingService\.processPostImage\(/);
  // Serial awaits made an N-image post wait for N full CDN round trips.
  assert.doesNotMatch(controller, /for \(let i = 0; i < imageFiles\.length; i\+\+\)/);

  assert.match(images, /POST_IMAGE_MAX_DIMENSION/);
  // EXIF orientation must be applied before sharp drops metadata on output.
  assert.match(images, /\.rotate\(\)/);
  // Animations must not be flattened to their first frame.
  assert.match(images, /gif/i);
});

test('viewer context refreshes behind the response instead of blocking it', () => {
  const context = source('src/modules/discovery/services/feed/feed-viewer-context.service.ts');
  const config = source('src/modules/discovery/services/feed/feed-config.ts');

  assert.match(context, /swr: \{/);
  assert.match(context, /softTtlSeconds: config\.pagination\.viewerContextTtlSeconds/);
  assert.match(context, /hardTtlSeconds/);
  // Both windows stay in feed-config, per the feed-v2 no-inline-constants policy.
  assert.match(config, /viewerContextHardTtlSeconds: \d/);
  assert.doesNotMatch(context, /ttlSeconds: \d/);
});

test('hot post and reel reads fetch relations with a join', () => {
  const schema = source('prisma/schema.prisma');
  const prismaConfig = source('src/config/prisma.ts');
  const posts = source('src/modules/content/controllers/post.controller.ts');
  const reels = source('src/modules/content/controllers/reels.controller.ts');

  assert.match(schema, /previewFeatures\s*=\s*\["relationJoins"\]/);
  assert.match(prismaConfig, /export const JOIN_RELATIONS: 'join' \| 'query'/);

  // Feed hydration is the read this exists for.
  const hydrate = posts.slice(
    posts.indexOf('async function hydrateFeedV2Page'),
    posts.indexOf('const postById = new Map(posts.map')
  );
  assert.match(hydrate, /relationLoadStrategy: JOIN_RELATIONS/);

  assert.ok((reels.match(/relationLoadStrategy: JOIN_RELATIONS/g) || []).length >= 10);

  // Joining is only safe because every included to-many relation is scoped to
  // one viewer. If that stops being true the join multiplies parent rows.
  const include = posts.slice(
    posts.indexOf('const postResponseInclude'),
    posts.indexOf('async function selectHomeFeedAdPlacements')
  );
  for (const relation of ['likes', 'saved_posts', 'pollVotes']) {
    const at = include.indexOf(`${relation}: {`);
    assert.notEqual(at, -1, `${relation} not found in postResponseInclude`);
    assert.match(
      include.slice(at, at + 160),
      /where: \{ userId: currentUserId \}/,
      `${relation} must stay viewer-scoped for relationLoadStrategy: 'join' to be safe`
    );
  }
});

test('the database pool is no longer capped at three connections', () => {
  const util = source('src/config/database-url.util.ts');
  const match = util.match(/const DEFAULT_CONNECTION_LIMIT = '(\d+)'/);

  assert.ok(match);
  assert.ok(
    Number(match[1]) >= 10,
    `expected a pool of at least 10 behind Neon's pooler, got ${match[1]}`
  );
});
