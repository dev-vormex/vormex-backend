import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheService } from '../services/cache.service';
import { redisCacheService } from '../infrastructure/cache/redis-cache.service';
import { register } from '../infrastructure/metrics/registry';

function testKey(name: string): string {
  return `test:${name}:${randomUUID()}`;
}

test('cacheService stores and retrieves application cache values', async () => {
  const key = testKey('get-set');

  await cacheService.set(key, { source: 'home-feed', cached: true }, 30, ['test:cache']);

  assert.deepEqual(await cacheService.get(key), {
    source: 'home-feed',
    cached: true,
  });
  assert.equal(await cacheService.exists(key), true);

  await cacheService.del(key);

  assert.equal(await cacheService.get(key), null);
  assert.equal(await cacheService.exists(key), false);
});

test('cacheService invalidates tagged home feed entries', async () => {
  const userFeedKey = testKey('feed-user');
  const otherFeedKey = testKey('feed-other');

  await cacheService.set(userFeedKey, { posts: ['post-1'] }, 30, ['feed:global', 'feed:user-1']);
  await cacheService.set(otherFeedKey, { posts: ['post-2'] }, 30, ['feed:global', 'feed:user-2']);

  await cacheService.invalidateTags('feed:user-1');

  assert.equal(await cacheService.get(userFeedKey), null);
  assert.deepEqual(await cacheService.get(otherFeedKey), { posts: ['post-2'] });

  await cacheService.del(otherFeedKey);
});

test('cacheService coalesces concurrent misses into one compute', async () => {
  const key = testKey('single-flight');
  let computes = 0;
  const compute = async () => {
    computes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { value: 'computed' };
  };

  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      cacheService.getOrSet(key, compute, { ttlSeconds: 30, lockTtlMs: 100 })
    )
  );

  assert.equal(computes, 1);
  assert.deepEqual(results, Array.from({ length: 12 }, () => ({ value: 'computed' })));
  assert.match(await register.metrics(), /vormex_cache_outcome_total\{operation="get_or_set",outcome="single-flight-wait"\}/);

  await cacheService.del(key);
});

test('cacheService applies TTL jitter within the expected range', () => {
  const samples = Array.from({ length: 50 }, () => redisCacheService.__testJitterTtlSeconds(100));

  assert.ok(samples.every((sample) => sample >= 85 && sample <= 115));
  assert.ok(new Set(samples).size > 1);
});

test('cacheService serves stale values while one background refresh recomputes', async () => {
  const key = testKey('swr');
  let computes = 0;

  const first = await cacheService.getOrSet(
    key,
    async () => {
      computes += 1;
      return { version: computes };
    },
    { swr: { softTtlSeconds: 0.01, hardTtlSeconds: 2 }, lockTtlMs: 100 }
  );
  assert.deepEqual(first, { version: 1 });

  await new Promise((resolve) => setTimeout(resolve, 30));

  const staleResults = await Promise.all(
    Array.from({ length: 8 }, () =>
      cacheService.getOrSet(
        key,
        async () => {
          computes += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { version: computes };
        },
        { swr: { softTtlSeconds: 1, hardTtlSeconds: 2 }, lockTtlMs: 100 }
      )
    )
  );

  assert.deepEqual(staleResults, Array.from({ length: 8 }, () => ({ version: 1 })));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(computes, 2);
  assert.deepEqual(await cacheService.get(key), { version: 2 });

  await cacheService.del(key);
});

test('cacheService releases single-flight state after compute failure', async () => {
  const key = testKey('failure-release');
  let computes = 0;

  await assert.rejects(
    cacheService.getOrSet(
      key,
      async () => {
        computes += 1;
        throw new Error('compute failed');
      },
      { ttlSeconds: 30, lockTtlMs: 100 }
    ),
    /compute failed/
  );

  const recovered = await cacheService.getOrSet(
    key,
    async () => {
      computes += 1;
      return { ok: true };
    },
    { ttlSeconds: 30, lockTtlMs: 100 }
  );

  assert.deepEqual(recovered, { ok: true });
  assert.equal(computes, 2);

  await cacheService.del(key);
});

test('reels webhook invalidates feed and reel cache tags after Bunny status changes', () => {
  const source = readFileSync(join(process.cwd(), 'src/controllers/reels.controller.ts'), 'utf8');
  const helper = source.slice(
    source.indexOf('function invalidateReelCacheTags'),
    source.indexOf('function applyDateCursor')
  );
  const webhook = source.slice(
    source.indexOf('export const transcodingWebhook'),
    source.length
  );

  assert.match(helper, /invalidateTags\(\s*'reels:feed'/s);
  assert.match(helper, /`reel:\$\{reel\.id\}`/);
  assert.match(helper, /`reels:user:\$\{reel\.authorId\}`/);
  assert.match(webhook, /statusString === 'ready'[\s\S]*invalidateReelCacheTags\(reelRecord\)/);
  assert.match(webhook, /statusString === 'failed'[\s\S]*invalidateReelCacheTags\(reelRecord\)/);
});
