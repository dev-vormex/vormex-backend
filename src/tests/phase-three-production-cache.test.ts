import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  cacheMetricNamespace,
  RedisCacheService,
} from '../infrastructure/cache/redis-cache.service';
import { profileViewAnalyticsJobId } from '../services/profile-view-analytics.service';

test('cache metric namespaces are bounded and never expose identifiers', () => {
  assert.equal(cacheMetricNamespace('profile:core:viewer-1:user-1'), 'profile');
  assert.equal(cacheMetricNamespace('feed:home:user-1'), 'feed');
  assert.equal(cacheMetricNamespace('totally-new:user-secret'), 'other');
});

test('memory fallback remains bounded and evicts least recently used entries', async () => {
  const cache = new RedisCacheService('cache', {
    forceMemory: true,
    maxMemoryEntries: 3,
  });

  await cache.set('phase3:a', 1, 30, ['phase3']);
  await cache.set('phase3:b', 2, 30, ['phase3']);
  await cache.set('phase3:c', 3, 30, ['phase3']);
  assert.equal(await cache.get('phase3:a'), 1);
  await cache.set('phase3:d', 4, 30, ['phase3']);

  assert.equal(cache.getStats().keys, 3);
  assert.equal(await cache.get('phase3:b'), null);
  assert.equal(await cache.get('phase3:a'), 1);
});

test('Redis tag TTL can only be initialized or extended', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/infrastructure/cache/redis-cache.service.ts'),
    'utf8'
  );

  assert.match(source, /expire\(this\.tagKey\(tag\), effectiveTtlSeconds, 'NX'\)/);
  assert.match(source, /expire\(this\.tagKey\(tag\), effectiveTtlSeconds, 'GT'\)/);
});

test('profile reads coalesce misses and core returns follow context', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/services/profile.service.ts'),
    'utf8'
  );
  const core = source.slice(
    source.indexOf('export async function getCoreProfile'),
    source.indexOf('export async function getFullProfile')
  );

  assert.match(core, /cacheService\.getOrSet/);
  assert.match(core, /prisma\.\$queryRaw<ProfileRelationshipRow\[\]>/);
  assert.match(source, /isFollowing: boolean/);
  assert.match(source, /isFollowedBy: boolean/);
  assert.match(source.slice(source.indexOf('export async function getFullProfile')), /cacheService\.getOrSet/);
});

test('automatic profile views enqueue analytics instead of querying social proof in API', () => {
  const profile = readFileSync(
    join(process.cwd(), 'src/services/profile.service.ts'),
    'utf8'
  );
  const worker = readFileSync(
    join(process.cwd(), 'src/workers/index.ts'),
    'utf8'
  );

  assert.match(profile, /enqueueProfileViewAnalytics/);
  assert.doesNotMatch(profile, /socialProofService\.trackProfileView/);
  assert.match(worker, /payload\.kind === 'profile_view'/);
  assert.match(worker, /socialProofService\.trackProfileView/);
});

test('profile-view analytics IDs de-duplicate one viewer/target time bucket', () => {
  const bucketStart = Date.UTC(2026, 6, 26, 18, 0, 0);
  const first = profileViewAnalyticsJobId('viewer-1', 'target-1', bucketStart);
  const repeated = profileViewAnalyticsJobId(
    'viewer-1',
    'target-1',
    bucketStart + 4 * 60_000
  );
  const nextWindow = profileViewAnalyticsJobId(
    'viewer-1',
    'target-1',
    bucketStart + 5 * 60_000
  );

  assert.equal(first, repeated);
  assert.notEqual(first, nextWindow);
  assert.match(first, /^profile-view-[a-f0-9]{32}$/);
});

test('cache observability labels backend and bounded namespace', () => {
  const metrics = readFileSync(
    join(process.cwd(), 'src/infrastructure/metrics/registry.ts'),
    'utf8'
  );
  assert.match(metrics, /vormex_cache_request_total/);
  assert.match(metrics, /vormex_cache_operation_duration_ms/);
  assert.match(metrics, /labelNames: \['operation', 'outcome', 'backend', 'namespace'\]/);
});

test('Android trusts core follow context without an extra profile-open request', () => {
  const viewModel = readFileSync(
    join(
      process.cwd(),
      '../vormex-android/catalog/src/main/java/com/kyant/backdrop/catalog/linkedin/ProfileViewModel.kt'
    ),
    'utf8'
  );

  assert.doesNotMatch(viewModel, /loadFollowStatus\(/);
  assert.match(viewModel, /isFollowing = mergedProfile\.viewerContext\.isFollowing/);
  assert.match(viewModel, /isFollowedBy = mergedProfile\.viewerContext\.isFollowedBy/);
});
