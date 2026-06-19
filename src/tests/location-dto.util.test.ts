import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bucketDistanceKm,
  serializeCoarseLocation,
} from '../utils/location-dto.util';

function assertNoCoordinateFields(value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach(assertNoCoordinateFields);
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert.notEqual(key, 'lat');
    assert.notEqual(key, 'lng');
    assert.notEqual(key, 'latitude');
    assert.notEqual(key, 'longitude');
    assertNoCoordinateFields(child);
  }
}

test('distance buckets expose coarse ranges only', () => {
  assert.equal(bucketDistanceKm(0.4), '<2km');
  assert.equal(bucketDistanceKm(2), '2-5km');
  assert.equal(bucketDistanceKm(5), '5-10km');
  assert.equal(bucketDistanceKm(10), '10-25km');
  assert.equal(bucketDistanceKm(25), '25-50km');
  assert.equal(bucketDistanceKm(50), '50km+');
  assert.equal(bucketDistanceKm(Number.NaN), null);
});

test('coarse location serializer never returns raw coordinates', () => {
  const dto = serializeCoarseLocation({
    currentCity: 'Hyderabad',
    currentState: 'Telangana',
    currentCountry: 'India',
  }, 3.2);

  assert.deepEqual(dto, {
    city: 'Hyderabad',
    region: 'Telangana',
    country: 'India',
    distanceBucket: '2-5km',
  });
  assertNoCoordinateFields(dto);
});

test('location, profile, and people response DTOs contain no coordinate fields', () => {
  const nearbyResponse = {
    users: [{
      id: 'user-2',
      location: serializeCoarseLocation({
        currentCity: 'Bengaluru',
        currentState: 'Karnataka',
        currentCountry: 'India',
      }, 8.4),
      distanceBucket: bucketDistanceKm(8.4),
    }],
    total: 1,
    yourLocation: serializeCoarseLocation({
      currentCity: 'Bengaluru',
      currentState: 'Karnataka',
      currentCountry: 'India',
    }),
  };
  const profileResponse = {
    user: {
      id: 'user-1',
      location: serializeCoarseLocation({
        currentCity: 'Pune',
        currentState: 'Maharashtra',
        currentCountry: 'India',
      }),
    },
  };
  const peopleResponse = {
    people: [{
      id: 'user-3',
      location: serializeCoarseLocation({
        currentCity: 'Delhi',
        currentState: 'Delhi',
        currentCountry: 'India',
      }, 1.1),
    }],
  };

  assertNoCoordinateFields(nearbyResponse);
  assertNoCoordinateFields(profileResponse);
  assertNoCoordinateFields(peopleResponse);
});
