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
    service.indexOf('/**\n * Load the independently cacheable lower profile sections')
  );

  assert.match(controller, /includes\.includes\('all'\)/);
  assert.match(controller, /getFullProfile/);
  assert.match(controller, /getCoreProfile/);
  assert.equal((core.match(/prisma\./g) || []).length, 3);
  assert.match(core, /viewerContext: toProfileConnectionState/);
});

test('sending a connection request batches its independent reads', () => {
  const controller = source('src/controllers/connection.controller.ts');
  const send = controller.slice(
    controller.indexOf('export const sendConnectionRequest'),
    controller.indexOf('export const acceptConnectionRequest')
  );

  // The receiver record, the requester's display name, any existing connection
  // row and the safety gate do not depend on each other. Awaiting them in
  // series was several avoidable round trips on every click.
  const batch = send.slice(send.indexOf('await Promise.all(['), send.indexOf(']);'));
  assert.match(batch, /where: \{ id: receiverId \}/);
  assert.match(batch, /select: \{ name: true \}/);
  assert.match(batch, /prisma\.connections\.findFirst/);
  assert.match(batch, /assertUsersCanInteract/);

  // Only the batch itself and the write remain on the request path.
  assert.equal((send.match(/await prisma\.user\.findUnique/g) || []).length, 0);
});

test('connection mutations answer before evicting discovery caches', () => {
  const controller = source('src/controllers/connection.controller.ts');

  // Tag invalidation fans out across every discovery list both users appear in
  // and the write is already durable, so the caller gained nothing by waiting.
  assert.doesNotMatch(controller, /await invalidateDiscoveryCaches/);
  assert.equal((controller.match(/void invalidateDiscoveryCaches/g) || []).length, 4);

  // Both cancel entry points — by connection id and by recipient — delegate to
  // withdrawSentRequest, so the eviction is asserted once, where it now lives.
  for (const handler of ['sendConnectionRequest', 'rejectConnectionRequest', 'withdrawSentRequest', 'removeConnection']) {
    const start = controller.indexOf(`const ${handler}`);
    assert.notEqual(start, -1, `${handler} not found`);
    const body = controller.slice(start, controller.indexOf('\n};', start));
    // Anchored on 2xx replies: the trailing catch block also writes a response,
    // and that one legitimately sits after the eviction call.
    assert.ok(
      body.lastIndexOf('res.status(20') < body.indexOf('void invalidateDiscoveryCaches'),
      `${handler} must respond before evicting caches`
    );
  }
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
