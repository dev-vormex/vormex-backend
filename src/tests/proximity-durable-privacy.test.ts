import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(__dirname, '../..');

test('durable proximity schema contains invariants but no coordinate columns', () => {
  const migration = readFileSync(resolve(root,
    'prisma/migrations/20260713100000_add_crossed_paths_core/migration.sql'), 'utf8');

  assert.doesNotMatch(migration, /\b(latitude|longitude|coordinates?|geography|geometry)\b/i);
  assert.match(migration, /"lowerUserId" < "higherUserId"/);
  assert.match(migration, /"expiresAt" = "lastSeenAt" \+ INTERVAL '7 days'/);
  assert.match(migration, /"expiresAt" <= "startedAt" \+ INTERVAL '8 hours'/);
  assert.match(migration, /proximity_encounter_pairs_lower_duration_idx/);
  assert.match(migration, /proximity_encounter_pairs_higher_duration_idx/);
});

test('accumulation queue contract carries identifiers only', () => {
  const types = readFileSync(resolve(root, 'src/types/proximity.types.ts'), 'utf8');
  const jobContract = types.match(/export interface AccumulateHeartbeatJob\s*{[\s\S]*?\n}/)?.[0];
  assert.ok(jobContract);
  assert.match(jobContract, /sessionId: string/);
  assert.match(jobContract, /sampleId: string/);
  assert.match(jobContract, /candidateUserIds: string\[\]/);
  assert.doesNotMatch(jobContract, /latitude|longitude|accuracyM|capturedAt/i);
});

test('flush claims are released to the dead-letter path after bounded terminal failure', () => {
  const worker = readFileSync(resolve(root, 'src/workers/proximity.ts'), 'utf8');
  assert.match(worker, /flushClaim\(hash\).*'NX'/s);
  assert.match(worker, /job\.queueName === proximityQueueNames\.persistence/);
  assert.match(worker, /deadLetter/);
  assert.match(worker, /del\(proximityKeys\.flushClaim\(parsed\.hash\)\)/);
});

test('atomic heartbeat stores a deterministic retry response in the Lua transaction', () => {
  const scripts = readFileSync(resolve(root, 'src/infrastructure/proximity/redis-scripts.ts'), 'utf8');
  assert.match(scripts, /redis\.call\('SET', KEYS\[8\], ARGV\[12\], 'EX'/);
  assert.match(scripts, /responseJson: string/);
});

test('public foreground presence uses the strict UUID heartbeat contract on both clients', () => {
  const controller = readFileSync(resolve(root, 'src/controllers/proximity.controller.ts'), 'utf8');
  const androidCoordinator = readFileSync(resolve(root,
    '../vormex-android/catalog/src/main/java/com/kyant/backdrop/catalog/location/CrossedPathsForegroundPresenceCoordinator.kt'), 'utf8');
  assert.doesNotMatch(controller, /`public-\$\{owner\}`/);
  assert.match(controller, /validateHeartbeat\(req\.body \|\| \{\}, sessionId\)/);
  assert.match(androidCoordinator, /UUID\.randomUUID\(\)\.toString\(\)/);
  assert.doesNotMatch(androidCoordinator, /"public-\$\{UUID\.randomUUID\(\)\}"/);
  assert.match(androidCoordinator, /pending: ProximityHeartbeatRequest\?/);
  assert.match(androidCoordinator, /pending = null/);
});

test('session start fails safely before or during initial Redis presence establishment', () => {
  const controller = readFileSync(resolve(root, 'src/controllers/proximity.controller.ts'), 'utf8');
  assert.match(controller, /!getProximityRedisHealth\(\)\.ready/);
  assert.match(controller, /endReason: 'initial_heartbeat_failed'/);
  assert.match(controller, /await removeUserProximityPresence\(owner\)/);
});

test('queue high-water marks are checked before accepting more accumulation or persistence work', () => {
  const presence = readFileSync(resolve(root, 'src/services/proximity-presence.service.ts'), 'utf8');
  const worker = readFileSync(resolve(root, 'src/workers/proximity.ts'), 'utf8');
  assert.match(presence, /getWaitingCount\(\) >= highWater/);
  assert.match(worker, /PROXIMITY_PERSISTENCE_QUEUE_HIGH_WATER/);
  assert.match(worker, /getWaitingCount\(\) >= highWater/);
});

test('expired sessions are claimed safely across multiple maintenance workers', () => {
  const worker = readFileSync(resolve(root, 'src/workers/proximity.ts'), 'utf8');
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /LIMIT 500/);
  assert.match(worker, /status: 'expired'/);
});

test('device rate-limit keys hash installation identifiers', () => {
  const routes = readFileSync(resolve(root, 'src/routes/proximity.routes.ts'), 'utf8');
  assert.match(routes, /createHash\('sha256'\)/);
  assert.match(routes, /hashedDeviceIdentifier\(req\.headers\['x-vormex-install-id'\]/);
});

test('structured logger redacts nested samples, coordinate arrays, and location query fields', () => {
  const logger = readFileSync(resolve(root, 'src/lib/logger.ts'), 'utf8');
  for (const path of ['req.body.sample', 'req.body.samples', 'req.body.coordinates', 'req.query.viewport', '*.*.latitude']) {
    assert.match(logger, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('pair accumulators stop growing after twelve hours until unflushed work is persisted', () => {
  const encounter = readFileSync(resolve(root, 'src/services/proximity-encounter.service.ts'), 'utf8');
  assert.match(encounter, /currentAt - existingFirstAt >= 43200000/);
  assert.match(encounter, /max_age_unflushed/);
  assert.match(encounter, /redis\.call\('ZADD', KEYS\[3\]/);
});
