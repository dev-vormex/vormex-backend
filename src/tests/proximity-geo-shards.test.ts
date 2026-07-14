import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeGeohashBounds,
  encodeGeohash,
  filterActiveShardsForRadius,
  radiusShardSearchPlan,
} from '../infrastructure/proximity/geo-shards';

test('radius shard plan crosses the international date line', () => {
  const plan = radiusShardSearchPlan(0, 179.999, 500);
  assert.equal(plan.useActiveShardRegistry, false);
  assert.ok(plan.shards.includes(encodeGeohash(0, -179.999)));
  assert.ok(plan.shards.includes(encodeGeohash(0, 179.999)));
});

test('dense high-latitude searches use and safely filter the active shard registry', () => {
  const latitude = 89.9999;
  const plan = radiusShardSearchPlan(latitude, 45, 500);
  assert.equal(plan.useActiveShardRegistry, true);

  const polarShard = encodeGeohash(89.999, -120);
  const oppositePolarShard = encodeGeohash(89.999, 120);
  const equatorialShard = encodeGeohash(0, 45);
  const filtered = filterActiveShardsForRadius([
    `proximity:v1:lastSeen:${polarShard}`,
    `proximity:v1:lastSeen:${oppositePolarShard}`,
    `proximity:v1:lastSeen:${equatorialShard}`,
    'malformed-registry-member',
  ], latitude, 45, 500);

  assert.deepEqual(new Set(filtered), new Set([polarShard, oppositePolarShard]));
});

test('decoded geohash bounds contain the encoded point', () => {
  const latitude = 12.9716;
  const longitude = 77.5946;
  const bounds = decodeGeohashBounds(encodeGeohash(latitude, longitude));
  assert.ok(latitude >= bounds.latMin && latitude <= bounds.latMax);
  assert.ok(longitude >= bounds.lonMin && longitude <= bounds.lonMax);
});
