import { requestWithBreaker } from "../../../../infrastructure/http/http-client-with-breaker.util";
import { PlatformCollege, CollegeSuggestion, findCatalogMatchByName, toSuggestion, buildInstitutionLogoUrl, fallbackInstitutionDomain, normalizeCollegeQuery, GOOGLE_PLACES_EDUCATION_TYPES, GOOGLE_PLACES_EDUCATION_KEYWORDS, GooglePlacePrediction, GoogleTextPlace, GOOGLE_PLACES_DETAILS_BASE_URL, GOOGLE_PLACES_TIMEOUT_MILLIS, GOOGLE_PLACES_DETAILS_FIELD_MASK, normalizeCollegeKey, GOOGLE_PLACES_AUTOCOMPLETE_URL, GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK, GOOGLE_PLACES_TEXT_SEARCH_SUFFIXES, GOOGLE_PLACES_TEXT_SEARCH_VARIANT_COUNT, GOOGLE_PLACES_TEXT_SEARCH_URL, GOOGLE_PLACES_INDIA_RESTRICTION, GOOGLE_PLACES_TEXT_SEARCH_FIELD_MASK, CollegeDbCollege } from "./normalize-college-query.service";

export function toPlatformSuggestion(platformCollege: PlatformCollege): CollegeSuggestion {
  const match = findCatalogMatchByName(platformCollege.name);

  return match
    ? { ...toSuggestion({ ...match, name: platformCollege.name }, 'platform', platformCollege.count) }
    : {
        id: null,
        name: platformCollege.name,
        count: platformCollege.count,
        logoUrl: buildInstitutionLogoUrl(platformCollege.name),
        domain: fallbackInstitutionDomain(platformCollege.name),
        country: 'India',
        state: null,
        city: null,
        kind: 'School',
        source: 'platform',
      };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? normalizeCollegeQuery(value) : '';
}

function googleTypesArray(types: unknown, primaryType?: unknown): string[] {
  const values = [
    ...(Array.isArray(types) ? types : []),
    primaryType,
  ];

  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function isEducationGoogleCandidate(name: string, address: string, types: unknown, primaryType?: unknown): boolean {
  const placeTypes = googleTypesArray(types, primaryType);
  if (placeTypes.some((type) => GOOGLE_PLACES_EDUCATION_TYPES.has(type))) {
    return true;
  }

  const text = `${name} ${address}`.toLowerCase();
  return GOOGLE_PLACES_EDUCATION_KEYWORDS.some((keyword) => text.includes(keyword));
}

function googlePlaceKind(types: unknown, name = '', primaryType?: unknown): string {
  const list = googleTypesArray(types, primaryType);
  const hasType = (type: string) => list.includes(type);
  const normalizedName = name.toLowerCase();
  if (hasType('university') || normalizedName.includes('university')) return 'University';
  if (normalizedName.includes('engineering college')) return 'Engineering college';
  if (
    normalizedName.includes('junior college') ||
    normalizedName.includes('inter college') ||
    normalizedName.includes('intermediate college') ||
    normalizedName.includes('pre-university') ||
    normalizedName.includes('pu college') ||
    normalizedName.includes('puc')
  ) {
    return 'Junior college';
  }
  if (normalizedName.includes('degree college') || normalizedName.includes('ug college')) return 'Degree college';
  if (normalizedName.includes('college')) return 'College';
  if (normalizedName.includes('institute') || hasType('research_institute')) return 'Institute';
  if (normalizedName.includes('academy')) return 'Academy';
  if (hasType('primary_school')) return 'Primary school';
  if (hasType('secondary_school')) return 'Secondary school';
  if (hasType('preschool')) return 'Preschool';
  if (hasType('educational_institution')) return 'Educational institution';
  return 'School';
}

function googleSecondaryParts(value: string): { city: string | null; state: string | null; country: string | null } {
  const parts = value
    .split(',')
    .map((part) => part.replace(/\b\d{5,6}\b/g, '').trim())
    .filter(Boolean);
  const country = parts.find((part) => part.toLowerCase() === 'india') || 'India';
  const withoutCountry = parts.filter((part) => part.toLowerCase() !== 'india');
  return {
    city: withoutCountry[0] || null,
    state: withoutCountry.length > 1 ? withoutCountry[withoutCountry.length - 1] : null,
    country,
  };
}

function googlePredictionToSuggestion(row: GooglePlacePrediction): CollegeSuggestion | null {
  const placeId = asString(row.placeId);
  const mainText = asString(row.structuredFormat?.mainText?.text);
  const text = asString(row.text?.text);
  const name = mainText || text.split(',')[0]?.trim() || '';
  if (!name) return null;

  const secondaryText = asString(row.structuredFormat?.secondaryText?.text);
  if (!isEducationGoogleCandidate(name, secondaryText || text, row.types)) return null;

  const location = googleSecondaryParts(secondaryText || text);
  const kind = googlePlaceKind(row.types, name);
  const domain = fallbackInstitutionDomain(name, kind);
  return {
    id: placeId || null,
    name,
    count: 0,
    logoUrl: buildInstitutionLogoUrl(name, domain, kind),
    domain,
    country: location.country,
    state: location.state,
    city: location.city,
    kind,
    source: 'google_places',
  };
}

function domainFromWebsiteUrl(value: unknown): string | null {
  const rawUrl = asString(value);
  if (!rawUrl) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    const domain = url.hostname.replace(/^www\./i, '').toLowerCase();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : null;
  } catch {
    return null;
  }
}

function googleTextPlaceToSuggestion(row: GoogleTextPlace): CollegeSuggestion | null {
  const name = asString(row.displayName?.text);
  const formattedAddress = asString(row.formattedAddress);
  if (!name || !isEducationGoogleCandidate(name, formattedAddress, row.types, row.primaryType)) return null;

  const location = googleSecondaryParts(formattedAddress);
  const kind = googlePlaceKind(row.types, name, row.primaryType);
  const domain = domainFromWebsiteUrl(row.websiteUri) || fallbackInstitutionDomain(name, kind);
  return {
    id: asString(row.id) || null,
    name,
    count: 0,
    logoUrl: buildInstitutionLogoUrl(name, domain, kind),
    domain,
    country: location.country,
    state: location.state,
    city: location.city,
    kind,
    source: 'google_places',
  };
}

async function enrichGoogleSuggestionWithPlaceDetails(
  college: CollegeSuggestion,
  apiKey: string
): Promise<CollegeSuggestion> {
  if (!college.id || college.logoUrl) return college;

  const placeId = college.id.startsWith('places/') ? college.id.slice('places/'.length) : college.id;
  if (!placeId) return college;

  try {
    const response = await requestWithBreaker<Record<string, unknown>>('google_places', 'details', {
      method: 'GET',
      url: `${GOOGLE_PLACES_DETAILS_BASE_URL}/${encodeURIComponent(placeId)}`,
        timeout: GOOGLE_PLACES_TIMEOUT_MILLIS,
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GOOGLE_PLACES_DETAILS_FIELD_MASK,
          'Content-Type': 'application/json',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: GOOGLE_PLACES_TIMEOUT_MILLIS });
    const detailed = googleTextPlaceToSuggestion(response.data || {});
    if (!detailed) return college;
    return mergeProviderSuggestions([college, detailed], 1)[0] || college;
  } catch (error: any) {
    const status = error?.response?.status;
    const detail = status ? `HTTP ${status}` : error?.message || error;
    console.warn(`Google Places details logo lookup failed for "${college.name}":`, detail);
    return college;
  }
}

function mergeProviderSuggestions(suggestions: CollegeSuggestion[], limit: number): CollegeSuggestion[] {
  const merged = new Map<string, CollegeSuggestion>();

  suggestions.forEach((college) => {
    const nameKey = normalizeCollegeKey(college.name);
    const key = college.id
      ? `id:${college.id}`
      : `name:${[nameKey, normalizeCollegeKey(college.city), normalizeCollegeKey(college.state)].filter(Boolean).join(':')}`;
    if (!key) return;

    const existing = merged.get(key);
    merged.set(key, existing
      ? {
          ...existing,
          id: existing.id || college.id,
          logoUrl: existing.logoUrl || college.logoUrl,
          domain: existing.domain || college.domain,
          country: existing.country || college.country,
          state: existing.state || college.state,
          city: existing.city || college.city,
          kind: existing.kind || college.kind,
        }
      : college);
  });

  return Array.from(merged.values()).slice(0, limit);
}

async function fetchGooglePlacesAutocompleteSuggestions(
  query: string,
  limit: number,
  apiKey: string,
  latitude?: number,
  longitude?: number
): Promise<CollegeSuggestion[]> {
  const normalizedQuery = normalizeCollegeQuery(query);
  try {
    const locationBias = latitude !== undefined && longitude !== undefined
      ? {
          circle: {
            center: { latitude, longitude },
            radius: 100000.0,
          },
        }
      : undefined;

    const response = await requestWithBreaker<{ suggestions?: unknown[] }>('google_places', 'autocomplete', {
      method: 'POST',
      url: GOOGLE_PLACES_AUTOCOMPLETE_URL,
      data: {
        input: normalizedQuery,
        includedRegionCodes: ['in'],
        languageCode: 'en',
        regionCode: 'IN',
        ...(locationBias ? { locationBias } : {}),
      },
        timeout: GOOGLE_PLACES_TIMEOUT_MILLIS,
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK,
          'Content-Type': 'application/json',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: GOOGLE_PLACES_TIMEOUT_MILLIS });

    const suggestions = Array.isArray(response.data?.suggestions) ? response.data.suggestions : [];
    const colleges = suggestions
      .map((item: any) => googlePredictionToSuggestion(item?.placePrediction || {}))
      .filter((college): college is CollegeSuggestion => Boolean(college))
      .slice(0, Math.min(limit, 5));
    return Promise.all(colleges.map((college) => enrichGoogleSuggestionWithPlaceDetails(college, apiKey)));
  } catch (error: any) {
    const status = error?.response?.status;
    const detail = status ? `HTTP ${status}` : error?.message || error;
    console.warn('Google Places autocomplete education search failed:', detail);
    return [];
  }
}

async function fetchGooglePlacesTextSearchSuggestions(
  query: string,
  limit: number,
  apiKey: string,
  latitude?: number,
  longitude?: number
): Promise<CollegeSuggestion[]> {
  const normalizedQuery = normalizeCollegeQuery(query);
  const textQueries = GOOGLE_PLACES_TEXT_SEARCH_SUFFIXES
    .slice(0, GOOGLE_PLACES_TEXT_SEARCH_VARIANT_COUNT)
    .map((suffix) => `${normalizedQuery} ${suffix}`);

  const locationBias = latitude !== undefined && longitude !== undefined
    ? {
        circle: {
          center: { latitude, longitude },
          radius: 100000.0,
        },
      }
    : undefined;

  const batches = await Promise.all(
    textQueries.map(async (textQuery) => {
      try {
        const response = await requestWithBreaker<{ places?: GoogleTextPlace[] }>('google_places', 'text_search', {
          method: 'POST',
          url: GOOGLE_PLACES_TEXT_SEARCH_URL,
          data: {
            textQuery,
            regionCode: 'IN',
            languageCode: 'en',
            pageSize: Math.min(Math.max(limit, 5), 10),
            locationRestriction: GOOGLE_PLACES_INDIA_RESTRICTION,
            ...(locationBias ? { locationBias } : {}),
          },
            timeout: GOOGLE_PLACES_TIMEOUT_MILLIS,
            headers: {
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': GOOGLE_PLACES_TEXT_SEARCH_FIELD_MASK,
              'Content-Type': 'application/json',
            },
            validateStatus: (status) => status >= 200 && status < 300,
        }, { connectTimeoutMs: 5_000, requestTimeoutMs: GOOGLE_PLACES_TIMEOUT_MILLIS });

        const places = Array.isArray(response.data?.places) ? response.data.places : [];
        return places
          .map((item: GoogleTextPlace) => googleTextPlaceToSuggestion(item))
          .filter((college): college is CollegeSuggestion => Boolean(college));
      } catch (error: any) {
        const status = error?.response?.status;
        const detail = status ? `HTTP ${status}` : error?.message || error;
        console.warn(`Google Places text education search failed for "${textQuery}":`, detail);
        return [];
      }
    })
  );

  return mergeProviderSuggestions(batches.flat(), limit);
}

export async function fetchGooglePlacesSchoolSuggestions(
  query: string,
  limit: number,
  latitude?: number,
  longitude?: number
): Promise<CollegeSuggestion[]> {
  const normalizedQuery = normalizeCollegeQuery(query);
  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (normalizedQuery.length < 2 || !apiKey || process.env.GOOGLE_PLACES_SCHOOL_SEARCH_ENABLED === 'false') {
    return [];
  }

  const [autocompleteSuggestions, textSearchSuggestions] = await Promise.all([
    fetchGooglePlacesAutocompleteSuggestions(normalizedQuery, limit, apiKey, latitude, longitude),
    fetchGooglePlacesTextSearchSuggestions(normalizedQuery, limit, apiKey, latitude, longitude),
  ]);

  return mergeProviderSuggestions([...autocompleteSuggestions, ...textSearchSuggestions], limit);
}

function normalizeCollegeDbKind(value: unknown): string {
  const normalized = normalizeCollegeQuery(value);
  return normalized || 'School';
}

export function collegeDbCollegeToSuggestion(row: CollegeDbCollege): CollegeSuggestion | null {
  const name = normalizeCollegeQuery(row.name);
  if (!name) return null;

  return {
    id: normalizeCollegeQuery(row.id) || null,
    name,
    count: 0,
    logoUrl: null,
    domain: null,
    country: 'India',
    state: normalizeCollegeQuery(row.state) || null,
    city: normalizeCollegeQuery(row.city) || null,
    kind: normalizeCollegeDbKind(row.type),
    source: 'collegedb',
  };
}
