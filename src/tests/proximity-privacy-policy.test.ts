import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalPair, pairHash, pairPartition } from '../infrastructure/proximity/redis-keys';
import { displaceMarker } from '../services/proximity-privacy.service';

function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (b.latitude - a.latitude) * radians;
  const longitudeDelta = (b.longitude - a.longitude) * radians;
  const h = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

test('canonical proximity pairs are stable and reject self-pairs', () => {
  assert.deepEqual(canonicalPair('user-b', 'user-a'), ['user-a', 'user-b']);
  assert.equal(pairHash('user-a', 'user-b'), pairHash('user-b', 'user-a'));
  assert.ok(pairPartition(pairHash('user-a', 'user-b')) >= 0);
  assert.ok(pairPartition(pairHash('user-a', 'user-b')) < 32);
  assert.throws(() => canonicalPair('same-user', 'same-user'));
});

test('event marker displacement is stable, viewer-specific, and between 30 and 75 metres', () => {
  const previous = process.env.PROXIMITY_MARKER_HMAC_SECRET;
  process.env.PROXIMITY_MARKER_HMAC_SECRET = 'test-only-marker-secret';
  try {
    const origin = { latitude: 12.9716, longitude: 77.5946 };
    const input = {
      ...origin,
      viewerId: 'viewer-a',
      targetId: 'target-a',
      viewerSessionId: 'session-a',
      targetGeneration: 1,
      mode: 'event' as const,
    };
    const first = displaceMarker(input);
    assert.deepEqual(displaceMarker(input), first);
    assert.notDeepEqual(displaceMarker({ ...input, viewerId: 'viewer-b' }), first);
    assert.ok(distanceM(origin, first) >= 29.5);
    assert.ok(distanceM(origin, first) <= 75.5);
  } finally {
    if (previous === undefined) delete process.env.PROXIMITY_MARKER_HMAC_SECRET;
    else process.env.PROXIMITY_MARKER_HMAC_SECRET = previous;
  }
});

test('public foreground marker displacement is between 100 and 200 metres', () => {
  const previous = process.env.PROXIMITY_MARKER_HMAC_SECRET;
  process.env.PROXIMITY_MARKER_HMAC_SECRET = 'test-only-marker-secret';
  try {
    const origin = { latitude: 12.9716, longitude: 77.5946 };
    const marker = displaceMarker({
      ...origin,
      viewerId: 'viewer-a',
      targetId: 'target-a',
      viewerSessionId: 'foreground-a',
      targetGeneration: 1,
      mode: 'public',
    });
    assert.ok(distanceM(origin, marker) >= 99.5);
    assert.ok(distanceM(origin, marker) <= 200.5);
  } finally {
    if (previous === undefined) delete process.env.PROXIMITY_MARKER_HMAC_SECRET;
    else process.env.PROXIMITY_MARKER_HMAC_SECRET = previous;
  }
});

test('privacy displacement preserves its distance range at high latitude and across the date line', () => {
  const previous = process.env.PROXIMITY_MARKER_HMAC_SECRET;
  process.env.PROXIMITY_MARKER_HMAC_SECRET = 'test-only-marker-secret';
  try {
    for (const origin of [
      { latitude: 89.999, longitude: 179.999 },
      { latitude: -89.999, longitude: -179.999 },
    ]) {
      const marker = displaceMarker({ ...origin, viewerId: 'viewer-polar', targetId: 'target-polar',
        viewerSessionId: 'session-polar', targetGeneration: 2, mode: 'event' });
      assert.ok(marker.latitude >= -90 && marker.latitude <= 90);
      assert.ok(marker.longitude >= -180 && marker.longitude <= 180);
      assert.ok(distanceM(origin, marker) >= 29.9);
      assert.ok(distanceM(origin, marker) <= 75.1);
    }
  } finally {
    if (previous === undefined) delete process.env.PROXIMITY_MARKER_HMAC_SECRET;
    else process.env.PROXIMITY_MARKER_HMAC_SECRET = previous;
  }
});
