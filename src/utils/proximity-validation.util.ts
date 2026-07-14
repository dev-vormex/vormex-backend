import type { ProximityHeartbeatInput, ProximitySampleInput } from '../types/proximity.types';

export class ProximityValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'ProximityValidationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SUPPORTED_PROXIMITY_RADII = [200, 300, 500] as const;
export const MAX_SAMPLE_AGE_MS = 5 * 60_000;
export const MAX_FUTURE_SKEW_MS = 30_000;

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProximityValidationError('PROXIMITY_INVALID_COORDINATES', `${field} must be finite`);
  }
  return value;
}

export function validateSample(body: Record<string, unknown>, now = Date.now()): ProximitySampleInput {
  const sampleId = String(body.sampleId || '');
  if (!UUID.test(sampleId)) throw new ProximityValidationError('PROXIMITY_INVALID_SAMPLE', 'sampleId must be a UUID');
  const latitude = finite(body.latitude, 'latitude');
  const longitude = finite(body.longitude, 'longitude');
  const accuracyM = finite(body.accuracyM, 'accuracyM');
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new ProximityValidationError('PROXIMITY_INVALID_COORDINATES', 'Coordinates are outside valid ranges');
  }
  if (accuracyM < 0 || accuracyM > 100) {
    throw new ProximityValidationError('PROXIMITY_INACCURATE_LOCATION', 'Location accuracy must be 100 metres or better', 422);
  }
  const capturedAt = new Date(String(body.capturedAt || ''));
  if (!Number.isFinite(capturedAt.getTime())) throw new ProximityValidationError('PROXIMITY_STALE_SAMPLE', 'capturedAt is invalid');
  if (capturedAt.getTime() > now + MAX_FUTURE_SKEW_MS || capturedAt.getTime() < now - MAX_SAMPLE_AGE_MS) {
    throw new ProximityValidationError('PROXIMITY_STALE_SAMPLE', 'Location sample is stale or has excessive clock skew', 422);
  }
  const speedMps = body.speedMps === undefined ? undefined : finite(body.speedMps, 'speedMps');
  if (speedMps !== undefined && (speedMps < 0 || speedMps > 120)) {
    throw new ProximityValidationError('PROXIMITY_INVALID_SAMPLE', 'speedMps is implausible');
  }
  return { sampleId, capturedAt: capturedAt.toISOString(), latitude, longitude, accuracyM, speedMps, movement: body.movement as ProximitySampleInput['movement'] };
}

export function validateHeartbeat(body: Record<string, unknown>, routeSessionId: string): ProximityHeartbeatInput {
  const allowed = new Set(['sessionId','generation','sequence','sampleId','capturedAt','latitude','longitude','accuracyM','speedMps','movement']);
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', `Unexpected field: ${extra}`);
  validateUuid(routeSessionId, 'sessionId');
  if (String(body.sessionId || '') !== routeSessionId) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'sessionId does not match route');
  const generation = Number(body.generation);
  const sequence = Number(body.sequence);
  if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ProximityValidationError('PROXIMITY_SEQUENCE_CONFLICT', 'generation and sequence must be positive integers', 409);
  }
  return { ...validateSample(body), sessionId: routeSessionId, generation, sequence };
}

export function validateUuid(value: unknown, field = 'id'): string {
  const id = String(value || '');
  if (!UUID.test(id)) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', `${field} must be a UUID`);
  return id;
}

export function validateSessionStart(body: Record<string, unknown>): ProximitySampleInput & {
  clientStartId: string;
  radiusM: number;
} {
  const allowed = new Set([
    'clientStartId', 'radiusM', 'sampleId', 'capturedAt', 'latitude', 'longitude',
    'accuracyM', 'speedMps', 'movement',
  ]);
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', `Unexpected field: ${extra}`);
  return {
    ...validateSample(body),
    clientStartId: normalizedClientStartId(body.clientStartId),
    radiusM: validateRadius(body.radiusM),
  };
}

export function validateRadius(value: unknown): number {
  const radius = Number(value);
  if (!(SUPPORTED_PROXIMITY_RADII as readonly number[]).includes(radius)) {
    throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'radiusM must be 200, 300, or 500');
  }
  return radius;
}

export function normalizedClientStartId(value: unknown): string {
  const id = String(value || '');
  if (!UUID.test(id)) {
    throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'clientStartId must be a UUID');
  }
  return id;
}
