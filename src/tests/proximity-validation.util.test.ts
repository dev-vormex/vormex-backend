import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProximityValidationError,
  validateHeartbeat,
  validateRadius,
  validateSample,
  validateSessionStart,
} from '../utils/proximity-validation.util';

const now = Date.parse('2026-07-13T04:30:00.000Z');
const validSample = {
  sampleId: '11111111-1111-4111-8111-111111111111',
  capturedAt: new Date(now).toISOString(),
  latitude: 12.9716,
  longitude: 77.5946,
  accuracyM: 25,
};

test('proximity sample accepts finite, fresh and sufficiently accurate coordinates', () => {
  const result = validateSample(validSample, now);
  assert.equal(result.sampleId, validSample.sampleId);
  assert.equal(result.latitude, validSample.latitude);
  assert.equal(result.longitude, validSample.longitude);
  assert.equal(result.accuracyM, validSample.accuracyM);
  assert.equal(result.capturedAt, validSample.capturedAt);
});

test('proximity sample rejects non-finite and inaccurate coordinates', () => {
  assert.throws(
    () => validateSample({ ...validSample, latitude: Number.NaN }, now),
    (error: unknown) => error instanceof ProximityValidationError
      && error.code === 'PROXIMITY_INVALID_COORDINATES',
  );
  assert.throws(
    () => validateSample({ ...validSample, accuracyM: 101 }, now),
    (error: unknown) => error instanceof ProximityValidationError
      && error.code === 'PROXIMITY_INACCURATE_LOCATION',
  );
});

test('proximity sample rejects stale and future-skewed timestamps', () => {
  assert.throws(
    () => validateSample({ ...validSample, capturedAt: new Date(now - 300_001).toISOString() }, now),
    (error: unknown) => error instanceof ProximityValidationError
      && error.code === 'PROXIMITY_STALE_SAMPLE',
  );
  assert.throws(
    () => validateSample({ ...validSample, capturedAt: new Date(now + 30_001).toISOString() }, now),
    (error: unknown) => error instanceof ProximityValidationError
      && error.code === 'PROXIMITY_STALE_SAMPLE',
  );
});

test('heartbeat schema is strict and route-bound', () => {
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const body = { ...validSample, capturedAt: new Date().toISOString(), sessionId, generation: 1, sequence: 1 };
  assert.equal(validateHeartbeat(body, sessionId).sequence, 1);
  assert.throws(() => validateHeartbeat({ ...body, rawCoordinates: [] }, sessionId));
  assert.throws(() => validateHeartbeat(body, 'different-session'));
});

test('session start requires a UUID idempotency key and rejects unexpected fields', () => {
  const valid = {
    ...validSample,
    capturedAt: new Date().toISOString(),
    clientStartId: '33333333-3333-4333-8333-333333333333',
    radiusM: 500,
  };
  assert.equal(validateSessionStart(valid).clientStartId, valid.clientStartId);
  assert.throws(() => validateSessionStart({ ...valid, clientStartId: 'not-a-uuid' }));
  assert.throws(() => validateSessionStart({ ...valid, exactLocationForClient: true }));
});

test('only supported product radii are accepted', () => {
  assert.equal(validateRadius(500), 500);
  assert.throws(() => validateRadius(501));
});
