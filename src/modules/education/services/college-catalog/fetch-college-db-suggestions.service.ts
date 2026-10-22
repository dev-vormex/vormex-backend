import { requestWithBreaker } from "../../../../infrastructure/http/http-client-with-breaker.util";
import { CollegeDbCollege, CollegeSuggestion, normalizeCollegeQuery, COLLEGE_DB_SEARCH_URL, COLLEGE_DB_TIMEOUT_MILLIS, DirectoryCollege, findCatalogMatchByName, toSuggestion, buildCollegeLogoUrl, COLLEGE_DIRECTORY_SEARCH_URL, COLLEGE_DIRECTORY_TIMEOUT_MILLIS, MAX_DIRECTORY_RESULTS, PlatformCollege, CollegeSuggestionSource, normalizeCollegeKey } from "./normalize-college-query.service";
import { collegeDbCollegeToSuggestion, toPlatformSuggestion } from "./fetch-google-places-school-suggestions.service";

export async function fetchCollegeDbSuggestions(
  query: string,
  limit: number
): Promise<CollegeSuggestion[]> {
  const normalizedQuery = normalizeCollegeQuery(query);
  const apiKey = process.env.COLLEGE_DB_API_KEY || process.env.COLLEGEDB_API_KEY;
  if (normalizedQuery.length < 2 || !apiKey || process.env.COLLEGE_DB_SEARCH_ENABLED === 'false') {
    return [];
  }

  try {
    const response = await requestWithBreaker<{ results?: CollegeDbCollege[] }>('college_db', 'search', {
      method: 'GET',
      url: COLLEGE_DB_SEARCH_URL,
      params: { q: normalizedQuery },
      timeout: COLLEGE_DB_TIMEOUT_MILLIS,
      headers: { Authorization: `Bearer ${apiKey}` },
      validateStatus: (status) => status >= 200 && status < 300,
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: COLLEGE_DB_TIMEOUT_MILLIS });
    const rows = Array.isArray(response.data?.results) ? response.data.results : [];
    return rows
      .map(collegeDbCollegeToSuggestion)
      .filter((college): college is CollegeSuggestion => Boolean(college))
      .slice(0, limit);
  } catch (error: any) {
    const status = error?.response?.status;
    const detail = status ? `HTTP ${status}` : error?.message || error;
    console.warn('CollegeDB search failed:', detail);
    return [];
  }
}

function firstString(values: unknown): string | null {
  if (Array.isArray(values)) {
    const first = values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return first ? normalizeCollegeQuery(first) : null;
  }
  return null;
}

function isIndiaCountry(value: unknown): boolean {
  const normalized = normalizeCollegeQuery(value).toLowerCase();
  return normalized === 'india' || normalized === 'in';
}

function directorySearchCountries(): string[] {
  const configured = normalizeCollegeQuery(process.env.COLLEGE_DIRECTORY_COUNTRY);
  return configured ? [configured] : ['India'];
}

function directoryCollegeToSuggestion(row: DirectoryCollege): CollegeSuggestion | null {
  const name = normalizeCollegeQuery(row.name);
  if (!name || !isIndiaCountry(row.country)) return null;

  const domain = firstString(row.domains);
  const country = normalizeCollegeQuery(row.country) || 'India';
  const state = normalizeCollegeQuery(row['state-province']) || null;
  const match = findCatalogMatchByName(name);
  if (match) {
    return {
      ...toSuggestion(match, 'directory'),
      country: match.country || country,
      state,
    };
  }

  return {
    id: null,
    name,
    count: 0,
    logoUrl: buildCollegeLogoUrl(domain),
    domain,
    country,
    state,
    city: null,
    kind: 'School',
    source: 'directory',
  };
}

export async function fetchDirectoryCollegeSuggestions(
  query: string,
  limit: number
): Promise<CollegeSuggestion[]> {
  const normalizedQuery = normalizeCollegeQuery(query);
  if (normalizedQuery.length < 2 || process.env.COLLEGE_DIRECTORY_SEARCH_ENABLED === 'false') {
    return [];
  }

  try {
    const responses = await Promise.all(
      directorySearchCountries().map((country) =>
        requestWithBreaker('college_directory', 'search', {
          method: 'GET',
          url: COLLEGE_DIRECTORY_SEARCH_URL,
          params: { name: normalizedQuery, country },
          timeout: COLLEGE_DIRECTORY_TIMEOUT_MILLIS,
          validateStatus: (status) => status >= 200 && status < 300,
        }, { connectTimeoutMs: 5_000, requestTimeoutMs: COLLEGE_DIRECTORY_TIMEOUT_MILLIS })
      )
    );
    const rows = responses.flatMap((response) =>
      Array.isArray(response.data) ? response.data.slice(0, MAX_DIRECTORY_RESULTS) : []
    );
    return rows
      .map(directoryCollegeToSuggestion)
      .filter((college): college is CollegeSuggestion => Boolean(college))
      .slice(0, limit);
  } catch (error) {
    console.warn('College directory search failed:', error instanceof Error ? error.message : error);
    return [];
  }
}

export function mergeCollegeSuggestions(
  platformColleges: PlatformCollege[],
  googlePlacesColleges: CollegeSuggestion[],
  collegeDbColleges: CollegeSuggestion[],
  catalogColleges: CollegeSuggestion[],
  directoryColleges: CollegeSuggestion[],
  limit: number
): CollegeSuggestion[] {
  const merged = new Map<string, CollegeSuggestion>();
  const sourceScore = (source: CollegeSuggestionSource): number =>
    source === 'google_places' ? 5 : source === 'collegedb' ? 4 : source === 'platform' ? 3 : source === 'catalog' ? 2 : 1;
  const add = (college: CollegeSuggestion) => {
    const key = normalizeCollegeKey(college.name);
    if (!key) return;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, college);
      return;
    }

    merged.set(key, {
      ...existing,
      id: existing.id || college.id,
      count: Math.max(existing.count, college.count),
      logoUrl: existing.logoUrl || college.logoUrl,
      domain: existing.domain || college.domain,
      country: existing.country || college.country,
      state: existing.state || college.state,
      city: existing.city || college.city,
      kind: existing.kind || college.kind,
      source: sourceScore(existing.source) >= sourceScore(college.source) ? existing.source : college.source,
    });
  };

  googlePlacesColleges.forEach(add);
  collegeDbColleges.forEach(add);
  platformColleges.map(toPlatformSuggestion).forEach(add);
  catalogColleges.forEach(add);
  directoryColleges.forEach(add);

  return Array.from(merged.values())
    .sort((left, right) => {
      const leftSourceScore = sourceScore(left.source);
      const rightSourceScore = sourceScore(right.source);
      if (leftSourceScore !== rightSourceScore) return rightSourceScore - leftSourceScore;
      if (left.count !== right.count) return right.count - left.count;
      return left.name.localeCompare(right.name);
    })
    .slice(0, limit);
}
