export type DistanceBucket =
  | '<2km'
  | '2-5km'
  | '5-10km'
  | '10-25km'
  | '25-50km'
  | '50km+';

export interface CoarseLocationDTO {
  city: string | null;
  region: string | null;
  country: string | null;
  distanceBucket?: DistanceBucket | null;
}

export interface CoarseLocationSource {
  currentCity?: string | null;
  currentState?: string | null;
  currentCountry?: string | null;
}

export function bucketDistanceKm(distanceKm: number | null | undefined): DistanceBucket | null {
  if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0) {
    return null;
  }

  if (distanceKm < 2) return '<2km';
  if (distanceKm < 5) return '2-5km';
  if (distanceKm < 10) return '5-10km';
  if (distanceKm < 25) return '10-25km';
  if (distanceKm < 50) return '25-50km';
  return '50km+';
}

export function serializeCoarseLocation(
  source: CoarseLocationSource | null | undefined,
  distanceKm?: number | null
): CoarseLocationDTO | null {
  const city = source?.currentCity || null;
  const region = source?.currentState || null;
  const country = source?.currentCountry || null;
  const distanceBucket = bucketDistanceKm(distanceKm);

  if (!city && !region && !country && !distanceBucket) {
    return null;
  }

  return {
    city,
    region,
    country,
    ...(distanceBucket ? { distanceBucket } : {}),
  };
}
