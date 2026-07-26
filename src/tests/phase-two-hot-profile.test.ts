import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeProfileCacheIdentifier,
  profileResponseCacheKey,
} from '../services/profile.service';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

function between(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `${start} not found`);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `${end} not found after ${start}`);
  return text.slice(startIndex, endIndex);
}

test('profile cache aliases normalize username, at-prefix, and viewer scope', () => {
  assert.equal(normalizeProfileCacheIdentifier('@Ada'), 'ada');
  assert.equal(normalizeProfileCacheIdentifier(' ADA '), 'ada');
  assert.equal(
    profileResponseCacheKey('core', 'viewer-1', '@Ada'),
    'profile:core:viewer-1:ada'
  );
  assert.equal(
    profileResponseCacheKey('bundle', null, 'USER-ID'),
    'profile:bundle:anon:user-id'
  );
});

test('core and full profile check the requested cache alias before querying user', () => {
  const service = source('src/services/profile.service.ts');
  const core = between(service, 'export async function getCoreProfile', '/**\n * Get full profile');
  const full = service.slice(service.indexOf('export async function getFullProfile'));

  assert.ok(core.indexOf('requestedCached') < core.indexOf('prisma.user.findFirst'));
  assert.ok(full.indexOf('requestedCached') < full.indexOf('prisma.user.findFirst'));
  assert.match(core, /profileResponseCacheKey\('core', requestingUserId, user\.username\)/);
  assert.match(full, /profileResponseCacheKey\('bundle', requestingUserId, user\.username\)/);
});

test('full profile relies on maintained counters instead of recounting on every open', () => {
  const service = source('src/services/profile.service.ts');
  const full = service.slice(service.indexOf('export async function getFullProfile'));

  assert.doesNotMatch(full, /prisma\.post\.groupBy/);
  assert.doesNotMatch(full, /prisma\.follows\.count/);
  assert.doesNotMatch(full, /prisma\.connections\.count/);
});

test('profile-view analytics are deferred outside profile read latency', () => {
  const service = source('src/services/profile.service.ts');

  assert.match(service, /function trackProfileViewLater/);
  assert.match(service, /setImmediate\(\(\) =>/);
  assert.doesNotMatch(
    service.slice(service.indexOf('export async function getFullProfile')),
    /void socialProofService\.trackProfileView/
  );
});
