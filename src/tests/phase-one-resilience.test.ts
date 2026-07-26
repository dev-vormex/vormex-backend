import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queueNames } from '../infrastructure/queue/queue-names';
import { resolveRedisRoleUrls } from '../infrastructure/redis/client';
import { evaluateBackgroundHeartbeat } from '../infrastructure/health/background-process-heartbeat';
import { classifyOutboxEventForDispatch } from '../outbox/dispatch-policy';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

test('Redis roles separate critical state from evictable application cache', () => {
  assert.deepEqual(
    resolveRedisRoleUrls({
      CRITICAL_REDIS_URL: 'redis://critical:6379',
      CACHE_REDIS_URL: 'redis://cache:6379',
    }),
    {
      criticalUrl: 'redis://critical:6379',
      cacheUrl: 'redis://cache:6379',
      shared: false,
    }
  );

  assert.deepEqual(resolveRedisRoleUrls({ REDIS_URL: 'redis://local:6379' }), {
    criticalUrl: 'redis://local:6379',
    cacheUrl: 'redis://local:6379',
    shared: true,
  });
});

test('sessions use the critical store while ordinary response caching uses the cache role', () => {
  const cache = source('src/infrastructure/cache/redis-cache.service.ts');
  const sessions = source('src/services/auth-session.service.ts');
  const queues = source('src/infrastructure/queue/queues.ts');

  assert.match(cache, /redisCacheCommand/);
  assert.match(cache, /redisSessionStore = new RedisCacheService\('critical'\)/);
  assert.match(sessions, /redisSessionStore\.get/);
  assert.match(sessions, /redisSessionStore\.set/);
  assert.doesNotMatch(sessions, /redisCacheService/);
  assert.match(queues, /isCriticalRedisEnabled/);
});

test('background heartbeat evaluation distinguishes healthy, stale, and missing processes', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const healthy = JSON.stringify({
    role: 'worker',
    instanceId: 'worker-1',
    pid: 1,
    startedAt: '2026-07-26T11:00:00.000Z',
    lastSeenAt: '2026-07-26T11:59:50.000Z',
  });
  const stale = JSON.stringify({
    role: 'worker',
    instanceId: 'worker-1',
    pid: 1,
    startedAt: '2026-07-26T11:00:00.000Z',
    lastSeenAt: '2026-07-26T11:59:00.000Z',
  });

  assert.equal(evaluateBackgroundHeartbeat(healthy, 'worker', now).status, 'healthy');
  assert.equal(evaluateBackgroundHeartbeat(stale, 'worker', now).status, 'stale');
  assert.equal(evaluateBackgroundHeartbeat(null, 'worker', now).status, 'missing');
  assert.equal(evaluateBackgroundHeartbeat(healthy, 'scheduler', now).status, 'missing');
});

test('readiness includes worker and scheduler heartbeat state', () => {
  const index = source('src/index.ts');
  const worker = source('src/worker.ts');
  const scheduler = source('src/scheduler.ts');

  assert.match(index, /getBackgroundProcessesHealth/);
  assert.match(index, /Object\.values\(redisHealth\.roles\)\.every/);
  assert.match(index, /redisReady && backgroundProcesses\.healthy/);
  assert.match(worker, /startBackgroundProcessHeartbeat\('worker'\)/);
  assert.match(scheduler, /startBackgroundProcessHeartbeat\('scheduler'\)/);
});

test('historical ephemeral outbox events expire without entering BullMQ', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const sixMinutesAgo = new Date(now - 6 * 60 * 1_000);
  const twentyFiveHoursAgo = new Date(now - 25 * 60 * 60 * 1_000);

  assert.equal(
    classifyOutboxEventForDispatch(
      { queueName: queueNames.realtimeFanout, createdAt: sixMinutesAgo },
      now
    ).action,
    'expire'
  );
  assert.equal(
    classifyOutboxEventForDispatch(
      { queueName: queueNames.notificationDelivery, createdAt: twentyFiveHoursAgo },
      now
    ).action,
    'expire'
  );
  assert.equal(
    classifyOutboxEventForDispatch(
      { queueName: queueNames.cacheInvalidation, createdAt: new Date(now - 5_000) },
      now
    ).action,
    'dispatch'
  );
});

test('durable outbox side effects replay while unclassified historical work is quarantined', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1_000);

  assert.equal(
    classifyOutboxEventForDispatch(
      { queueName: queueNames.connectionSideEffects, createdAt: sixtyDaysAgo },
      now
    ).action,
    'dispatch'
  );
  assert.equal(
    classifyOutboxEventForDispatch(
      { queueName: queueNames.maintenance, createdAt: sixtyDaysAgo },
      now
    ).action,
    'quarantine'
  );
});

test('dispatcher persists terminal age decisions before continuing the batch', () => {
  const dispatcher = source('src/outbox/dispatcher.ts');

  assert.match(dispatcher, /o\."createdAt"/);
  assert.match(dispatcher, /classifyOutboxEventForDispatch\(event\)/);
  assert.match(dispatcher, /'expired' : 'quarantined'/);
  assert.match(dispatcher, /status = \$\{terminalStatus\}/);
});
