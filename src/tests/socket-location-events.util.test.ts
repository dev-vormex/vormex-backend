import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAuthorizedPresenceRooms,
  buildCoarseSocketLocation,
  buildSocketLocationEventPayload,
  shouldThrottleSocketLocationUpdate,
  validateSocketLocationPayload,
} from '../utils/socket-location-events.util';

function assertNoCoordinates(value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach(assertNoCoordinates);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.notEqual(key, 'lat');
    assert.notEqual(key, 'lng');
    assert.notEqual(key, 'latitude');
    assert.notEqual(key, 'longitude');
    assertNoCoordinates(child);
  }
}

test('location socket payloads are schema validated', () => {
  assert.equal(validateSocketLocationPayload({ lat: 17.4 }).ok, false);
  assert.equal(validateSocketLocationPayload({ lat: 91, lng: 78 }).ok, false);
  assert.equal(validateSocketLocationPayload({ city: '<script>' }).ok, false);
  assert.equal(validateSocketLocationPayload({ city: 'Hyderabad', extra: true }).ok, false);

  assert.deepEqual(validateSocketLocationPayload({
    lat: 17.4,
    lng: 78.4,
    city: 'Hyderabad',
    region: 'Telangana',
    country: 'India',
  }), {
    ok: true,
    value: {
      lat: 17.4,
      lng: 78.4,
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
    },
  });
});

test('location socket events never emit exact coordinates', () => {
  const validation = validateSocketLocationPayload({
    lat: 17.42,
    lng: 78.48,
    city: 'Hyderabad',
    state: 'Telangana',
  });
  assert.equal(validation.ok, true);

  const location = buildCoarseSocketLocation(validation.value!, {
    currentCity: 'Fallback',
    currentState: 'Fallback State',
    currentCountry: 'India',
  });
  const payload = buildSocketLocationEventPayload({
    id: 'user-1',
    shareLocationPublic: true,
  }, location);

  assert.deepEqual(payload, {
    userId: 'user-1',
    location: {
      city: 'Hyderabad',
      region: 'Telangana',
      country: 'India',
    },
  });
  assertNoCoordinates(payload);
});

test('non-opted-in users are never broadcast', () => {
  const payload = buildSocketLocationEventPayload({
    id: 'user-private',
    shareLocationPublic: false,
  }, {
    city: 'Hyderabad',
    region: 'Telangana',
    country: 'India',
  });

  assert.equal(payload, null);
});

test('authorized socket rooms exclude unrelated sockets', () => {
  const rooms = buildAuthorizedPresenceRooms(['friend-1', 'friend-2'], {
    city: 'Hyderabad',
    region: 'Telangana',
    country: 'India',
  });

  assert.deepEqual(rooms.sort(), [
    'nearby:telangana:hyderabad',
    'user:friend-1',
    'user:friend-2',
  ]);
  assert.equal(rooms.includes('user:unrelated'), false);
});

test('location socket updates are throttled per user', () => {
  const timestamps = new Map<string, number>();

  assert.equal(shouldThrottleSocketLocationUpdate(timestamps, 'user-1', 10_000), false);
  assert.equal(shouldThrottleSocketLocationUpdate(timestamps, 'user-1', 12_000), true);
  assert.equal(shouldThrottleSocketLocationUpdate(timestamps, 'user-1', 16_000), false);
});
