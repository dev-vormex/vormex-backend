import {
  CoarseLocationDTO,
  CoarseLocationSource,
  serializeCoarseLocation,
} from './location-dto.util';

export interface SocketLocationPayload {
  lat?: number;
  lng?: number;
  city?: string;
  state?: string;
  region?: string;
  country?: string;
}

export interface SocketLocationEventPayload {
  userId: string;
  location: CoarseLocationDTO | null;
}

export interface RealtimeLocationUser {
  id: string;
  shareLocationPublic?: boolean | null;
  currentCity?: string | null;
  currentState?: string | null;
  currentCountry?: string | null;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const MAX_LOCATION_TEXT_LENGTH = 80;
const LOCATION_TEXT_PATTERN = /^[\p{L}\p{N} .,'()/-]+$/u;
const COORDINATE_DECIMAL_PATTERN = /^-?\d+\.\d+$/;
export const SOCKET_LOCATION_UPDATE_THROTTLE_MS = 5_000;

function reject<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function normalizeLocationText(value: unknown, fieldName: string): ValidationResult<string | undefined> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }

  if (typeof value !== 'string') {
    return reject(`${fieldName} must be a string`);
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return { ok: true, value: undefined };
  }

  if (
    normalized.length > MAX_LOCATION_TEXT_LENGTH ||
    !LOCATION_TEXT_PATTERN.test(normalized) ||
    COORDINATE_DECIMAL_PATTERN.test(normalized)
  ) {
    return reject(`${fieldName} is invalid`);
  }

  return { ok: true, value: normalized };
}

function normalizeCoordinate(value: unknown, fieldName: string): ValidationResult<number | undefined> {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return reject(`${fieldName} must be a finite number`);
  }

  if (fieldName === 'lat' && (value < -90 || value > 90)) {
    return reject('lat is invalid');
  }

  if (fieldName === 'lng' && (value < -180 || value > 180)) {
    return reject('lng is invalid');
  }

  return { ok: true, value };
}

export function validateSocketLocationPayload(payload: unknown): ValidationResult<SocketLocationPayload> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return reject('location:update payload must be an object');
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set(['lat', 'lng', 'city', 'state', 'region', 'country']);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      return reject(`location:update contains unsupported field ${key}`);
    }
  }

  const lat = normalizeCoordinate(record.lat, 'lat');
  if (!lat.ok) return reject(lat.error || 'lat is invalid');

  const lng = normalizeCoordinate(record.lng, 'lng');
  if (!lng.ok) return reject(lng.error || 'lng is invalid');

  if ((lat.value === undefined) !== (lng.value === undefined)) {
    return reject('lat and lng must be provided together');
  }

  const city = normalizeLocationText(record.city, 'city');
  if (!city.ok) return reject(city.error || 'city is invalid');

  const state = normalizeLocationText(record.state ?? record.region, 'region');
  if (!state.ok) return reject(state.error || 'region is invalid');

  const country = normalizeLocationText(record.country, 'country');
  if (!country.ok) return reject(country.error || 'country is invalid');

  if (
    lat.value === undefined &&
    lng.value === undefined &&
    !city.value &&
    !state.value &&
    !country.value
  ) {
    return reject('location:update requires a location signal');
  }

  return {
    ok: true,
    value: {
      ...(lat.value !== undefined ? { lat: lat.value } : {}),
      ...(lng.value !== undefined ? { lng: lng.value } : {}),
      ...(city.value ? { city: city.value } : {}),
      ...(state.value ? { state: state.value } : {}),
      ...(country.value ? { country: country.value } : {}),
    },
  };
}

export function buildCoarseSocketLocation(
  payload: SocketLocationPayload,
  fallback: CoarseLocationSource
): CoarseLocationDTO | null {
  return serializeCoarseLocation({
    currentCity: payload.city ?? fallback.currentCity ?? null,
    currentState: payload.state ?? fallback.currentState ?? null,
    currentCountry: payload.country ?? fallback.currentCountry ?? null,
  });
}

export function coarseNearbyRoom(location: CoarseLocationDTO | null): string | null {
  const city = location?.city?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const region = location?.region?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!city || !region) {
    return null;
  }

  return `nearby:${region}:${city}`;
}

export function buildAuthorizedPresenceRooms(
  connectionIds: string[],
  location: CoarseLocationDTO | null
): string[] {
  const rooms = new Set<string>();
  for (const connectionId of connectionIds) {
    if (connectionId) {
      rooms.add(`user:${connectionId}`);
    }
  }

  const nearbyRoom = coarseNearbyRoom(location);
  if (nearbyRoom) {
    rooms.add(nearbyRoom);
  }

  return Array.from(rooms);
}

export function buildSocketLocationEventPayload(
  user: RealtimeLocationUser,
  location: CoarseLocationDTO | null
): SocketLocationEventPayload | null {
  if (user.shareLocationPublic !== true) {
    return null;
  }

  return {
    userId: user.id,
    location,
  };
}

export function shouldThrottleSocketLocationUpdate(
  timestamps: Map<string, number>,
  userId: string,
  nowMs: number = Date.now()
): boolean {
  const lastUpdatedAt = timestamps.get(userId) ?? 0;
  if (nowMs - lastUpdatedAt < SOCKET_LOCATION_UPDATE_THROTTLE_MS) {
    return true;
  }

  timestamps.set(userId, nowMs);
  return false;
}
