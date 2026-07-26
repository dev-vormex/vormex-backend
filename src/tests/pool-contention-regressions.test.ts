import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

test('global and route authentication share one resolved request state', () => {
  const auth = source('src/middleware/auth.middleware.ts');
  const resolver = auth.slice(
    auth.indexOf('async function resolveRequestAuth'),
    auth.indexOf('/**\n * Authentication middleware')
  );
  const optional = auth.slice(auth.indexOf('export const optionalAuth'));

  assert.match(resolver, /if \(req\.authState\)/);
  assert.match(resolver, /req\.authState =/);
  assert.equal((resolver.match(/verifyAccessToken\(/g) || []).length, 1);
  assert.match(optional, /resolveRequestAuth\(req\)/);
  assert.doesNotMatch(optional, /verifyAccessToken\(/);
});

test('profile defaults to core and keeps the legacy bundle behind include=all', () => {
  const controller = source('src/controllers/profile.controller.ts');
  const service = source('src/services/profile.service.ts');
  const core = service.slice(
    service.indexOf('export async function getCoreProfile'),
    service.indexOf('/**\n * Get full profile')
  );

  assert.match(controller, /includes\.includes\('all'\)/);
  assert.match(controller, /getFullProfile/);
  assert.match(controller, /getCoreProfile/);
  assert.equal((core.match(/prisma\./g) || []).length, 3);
  assert.match(core, /viewerContext: toProfileConnectionState/);
});

test('connection acceptance only updates state and writes a transactional outbox event', () => {
  const controller = source('src/controllers/connection.controller.ts');
  const accept = controller.slice(
    controller.indexOf('export const acceptConnectionRequest'),
    controller.indexOf('export const rejectConnectionRequest')
  );
  const workers = source('src/workers/index.ts');
  const sideEffects = source('src/services/connection-accepted-side-effects.service.ts');

  assert.match(accept, /enqueueOutboxEvent\(tx/);
  assert.match(accept, /connectionSideEffects/);
  assert.doesNotMatch(accept, /recordActivity|updateEngagementStreak|pushConnectionAccepted|invalidateDiscoveryCaches/);
  assert.match(workers, /createWorker\(queueNames\.connectionSideEffects, processAcceptedConnection, 1\)/);
  assert.doesNotMatch(sideEffects, /Promise\.all/);
});

test('Redis request commands and reconnect attempts are bounded', () => {
  const redis = source('src/infrastructure/redis/client.ts');
  const proximity = source('src/infrastructure/proximity/redis-client.ts');

  assert.match(redis, /maxRetriesPerRequest: blocking \? null : 1/);
  assert.match(redis, /if \(times > maxAttempts\)/);
  assert.match(redis, /250 \* 2 \*\*/);
  assert.match(proximity, /if \(attempt > maxAttempts\) return null/);
});
