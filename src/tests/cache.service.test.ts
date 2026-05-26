import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { cacheService } from '../services/cache.service';

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
