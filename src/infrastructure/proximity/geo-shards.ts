const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const EARTH_RADIUS_M = 6_371_000;
const GEOHASH6_LAT_CELL_DEGREES = 180 / 2 ** 15;
const GEOHASH6_LON_CELL_DEGREES = 360 / 2 ** 15;

type LongitudeRange = { min: number; max: number };

export type RadiusShardSearchPlan = {
  shards: string[];
  useActiveShardRegistry: boolean;
};

function normalizeLongitude(longitude: number): number {
  let normalized = longitude;
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return normalized;
}

function radiusBounds(latitude: number, longitude: number, radiusM: number): {
  latMin: number;
  latMax: number;
  longitudeRanges: LongitudeRange[];
} {
  const angularRadius = (radiusM + 120) / EARTH_RADIUS_M;
  const latitudeRadians = latitude * Math.PI / 180;
  const latitudeDelta = angularRadius * 180 / Math.PI;
  const latMin = Math.max(-90, latitude - latitudeDelta);
  const latMax = Math.min(90, latitude + latitudeDelta);
  if (Math.abs(latitudeRadians) + angularRadius >= Math.PI / 2) {
    return { latMin, latMax, longitudeRanges: [{ min: -180, max: 180 }] };
  }

  const longitudeDelta = Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitudeRadians))) * 180 / Math.PI;
  const min = normalizeLongitude(longitude - longitudeDelta);
  const max = normalizeLongitude(longitude + longitudeDelta);
  const wrapsDateLine = min > max;
  return {
    latMin,
    latMax,
    longitudeRanges: wrapsDateLine
      ? [{ min: -180, max }, { min, max: 180 }]
      : [{ min, max }],
  };
}

export function encodeGeohash(latitude: number, longitude: number, precision = 6): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let even = true, bit = 0, value = 0, result = '';
  while (result.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (longitude >= mid) { value = value * 2 + 1; lonMin = mid; } else { value *= 2; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) { value = value * 2 + 1; latMin = mid; } else { value *= 2; latMax = mid; }
    }
    even = !even;
    bit += 1;
    if (bit === 5) { result += BASE32[value]; bit = 0; value = 0; }
  }
  return result;
}

export function radiusShardSearchPlan(latitude: number, longitude: number, radiusM: number): RadiusShardSearchPlan {
  const { latMin, latMax, longitudeRanges } = radiusBounds(latitude, longitude, radiusM);
  // Precision six has fifteen interleaved bits for each axis. Sampling at half a
  // cell guarantees every rectangular shard touched by the accuracy-expanded
  // bounding box is represented, including thin boundary intersections.
  const latStep = GEOHASH6_LAT_CELL_DEGREES / 2;
  const lonStep = GEOHASH6_LON_CELL_DEGREES / 2;
  const estimatedSamples = (Math.ceil((latMax - latMin) / latStep) + 2)
    * longitudeRanges.reduce((sum, range) => sum + Math.ceil((range.max - range.min) / lonStep) + 2, 0);
  // Near a pole, enumerating longitude cells grows dramatically. Query only the
  // recently active shard registry in that case, then apply the same bounds.
  if (estimatedSamples > 512) return { shards: [], useActiveShardRegistry: true };

  const longitudes: number[] = [];
  for (const range of longitudeRanges) {
    for (let value = range.min; value <= range.max + lonStep / 10; value += lonStep) {
      longitudes.push(Math.min(value, range.max));
    }
    longitudes.push(range.max);
  }
  const shards = new Set<string>();
  for (let lat = latMin; lat <= latMax + latStep / 10; lat += latStep) {
    for (const lon of longitudes) shards.add(encodeGeohash(Math.min(lat, latMax), lon));
  }
  for (const lon of longitudes) shards.add(encodeGeohash(latMax, lon));
  return { shards: Array.from(shards), useActiveShardRegistry: false };
}

export function shardsForRadius(latitude: number, longitude: number, radiusM: number): string[] {
  return radiusShardSearchPlan(latitude, longitude, radiusM).shards;
}

export function decodeGeohashBounds(hash: string): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
  let latMin = -90; let latMax = 90; let lonMin = -180; let lonMax = 180; let even = true;
  for (const character of hash.toLowerCase()) {
    const value = BASE32.indexOf(character);
    if (value < 0) throw new Error('Invalid geohash');
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (value & mask) lonMin = mid; else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (value & mask) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return { latMin, latMax, lonMin, lonMax };
}

export function filterActiveShardsForRadius(
  activeRegistryMembers: string[],
  latitude: number,
  longitude: number,
  radiusM: number,
): string[] {
  const { latMin, latMax, longitudeRanges } = radiusBounds(latitude, longitude, radiusM);
  const prefix = 'proximity:v1:lastSeen:';
  const matched = new Set<string>();
  for (const member of activeRegistryMembers) {
    const shard = member.startsWith(prefix) ? member.slice(prefix.length) : member;
    if (shard.length !== 6) continue;
    let bounds: ReturnType<typeof decodeGeohashBounds>;
    try { bounds = decodeGeohashBounds(shard); } catch { continue; }
    if (bounds.latMax < latMin || bounds.latMin > latMax) continue;
    if (!longitudeRanges.some((range) => bounds.lonMax >= range.min && bounds.lonMin <= range.max)) continue;
    matched.add(shard);
  }
  return Array.from(matched);
}

export function deterministicCohort(userId: string): number {
  let hash = 2166136261;
  for (const char of userId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash) % 8;
}

export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
