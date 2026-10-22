import { requestWithBreaker } from "../../../../infrastructure/http/http-client-with-breaker.util";

export type CollegeSuggestionSource = 'google_places' | 'collegedb' | 'platform' | 'catalog' | 'directory';

export interface CollegeCatalogEntry {
  name: string;
  domain?: string;
  country?: string;
  city?: string;
  kind?: string;
  aliases?: string[];
  priority?: number;
}

export interface CollegeSuggestion {
  id: string | null;
  name: string;
  count: number;
  logoUrl: string | null;
  domain: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  kind: string | null;
  source: CollegeSuggestionSource;
}

export type PlatformCollege = {
  name: string;
  count: number;
};

export type DirectoryCollege = {
  name?: unknown;
  country?: unknown;
  'state-province'?: unknown;
  domains?: unknown;
  web_pages?: unknown;
};

export type CollegeDbCollege = {
  id?: unknown;
  name?: unknown;
  city?: unknown;
  state?: unknown;
  type?: unknown;
};

export type GooglePlacePrediction = {
  placeId?: unknown;
  text?: { text?: unknown };
  structuredFormat?: {
    mainText?: { text?: unknown };
    secondaryText?: { text?: unknown };
  };
  types?: unknown;
};

export type GoogleTextPlace = {
  id?: unknown;
  displayName?: { text?: unknown };
  formattedAddress?: unknown;
  primaryType?: unknown;
  types?: unknown;
  websiteUri?: unknown;
};

export const GOOGLE_PLACES_AUTOCOMPLETE_URL =
  process.env.GOOGLE_PLACES_AUTOCOMPLETE_URL || 'https://places.googleapis.com/v1/places:autocomplete';

export const GOOGLE_PLACES_TEXT_SEARCH_URL =
  process.env.GOOGLE_PLACES_TEXT_SEARCH_URL || 'https://places.googleapis.com/v1/places:searchText';

export const GOOGLE_PLACES_DETAILS_BASE_URL =
  process.env.GOOGLE_PLACES_DETAILS_BASE_URL || 'https://places.googleapis.com/v1/places';

export const COLLEGE_DB_SEARCH_URL =
  process.env.COLLEGE_DB_SEARCH_URL || 'https://api.collegedb.in/v1/colleges/search';

export const COLLEGE_DIRECTORY_SEARCH_URL =
  process.env.COLLEGE_DIRECTORY_SEARCH_URL || 'http://universities.hipolabs.com/search';

export const COLLEGE_DIRECTORY_TIMEOUT_MILLIS = 2_500;

export const COLLEGE_DB_TIMEOUT_MILLIS = 2_500;

export const GOOGLE_PLACES_TIMEOUT_MILLIS = 2_500;

const COLLEGE_LOGO_TIMEOUT_MILLIS = 3_000;

export const MAX_DIRECTORY_RESULTS = 40;

export const GOOGLE_PLACES_TEXT_SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.primaryType,places.types,places.websiteUri';

export const GOOGLE_PLACES_DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,primaryType,types,websiteUri';

export const GOOGLE_PLACES_AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text,suggestions.placePrediction.types';

export const GOOGLE_PLACES_INDIA_RESTRICTION = {
  rectangle: {
    low: { latitude: 6.4627, longitude: 68.1097 },
    high: { latitude: 35.5133, longitude: 97.3956 },
  },
};

export const GOOGLE_PLACES_TEXT_SEARCH_SUFFIXES = [
  'educational institution India',
  'school India',
  'junior college India',
  'college India',
  'engineering college India',
  'degree college India',
  'institute India',
];

export const GOOGLE_PLACES_TEXT_SEARCH_VARIANT_COUNT = Math.min(
  Math.max(Number.parseInt(process.env.GOOGLE_PLACES_TEXT_SEARCH_VARIANT_COUNT || '7', 10) || 7, 1),
  GOOGLE_PLACES_TEXT_SEARCH_SUFFIXES.length
);

export const GOOGLE_PLACES_EDUCATION_TYPES = new Set([
  'school',
  'university',
  'educational_institution',
  'primary_school',
  'secondary_school',
  'preschool',
  'academic_department',
  'research_institute',
]);

export const GOOGLE_PLACES_EDUCATION_KEYWORDS = [
  'school',
  'college',
  'junior college',
  'inter college',
  'intermediate college',
  'degree college',
  'ug college',
  'engineering college',
  'university',
  'institute',
  'institution',
  'academy',
  'polytechnic',
  'vidyalaya',
  'vihar',
  'gurukulam',
  'p.u. college',
  'pre-university',
  'campus',
  'convent',
  'iti',
  'puc',
  'pu college',
  'jr college',
  'jr. college',
];

const COLLEGE_CATALOG: CollegeCatalogEntry[] = [
  { name: 'Narayana Educational Institutions', domain: 'narayanagroup.com', country: 'India', city: 'Hyderabad', kind: 'Educational institution', aliases: ['Narayana Group', 'Narayana Group of Educational Institutions'], priority: 96 },
  { name: 'Narayana Schools', domain: 'narayanaschools.in', country: 'India', kind: 'School', aliases: ['Narayana School'], priority: 95 },
  { name: 'Narayana Junior Colleges', domain: 'narayanajuniorcolleges.com', country: 'India', kind: 'Junior college', aliases: ['Narayana Junior College', 'Narayana Inter College', 'Narayana Intermediate College'], priority: 95 },
  { name: 'Sri Chaitanya Educational Institutions', domain: 'srichaitanya.net', country: 'India', city: 'Hyderabad', kind: 'Educational institution', aliases: ['Sri Chaitanya Group', 'Sri Chaitanya Group of Educational Institutions'], priority: 96 },
  { name: 'Sri Chaitanya Schools', domain: 'srichaitanyaschool.net', country: 'India', kind: 'School', aliases: ['Sri Chaitanya School'], priority: 95 },
  { name: 'Sri Chaitanya Junior Colleges', domain: 'srichaitanya.net', country: 'India', kind: 'Junior college', aliases: ['Sri Chaitanya Junior College', 'Sri Chaitanya Inter College', 'Sri Chaitanya Intermediate College'], priority: 95 },
  { name: 'Narayana Engineering College, Gudur', domain: 'necg.ac.in', country: 'India', city: 'Gudur', kind: 'Engineering college', aliases: ['NEC Gudur', 'Narayana Engineering College Gudur'], priority: 84 },
  { name: 'Narayana Engineering College, Nellore', domain: 'necn.ac.in', country: 'India', city: 'Nellore', kind: 'Engineering college', aliases: ['NEC Nellore', 'Narayana Engineering College Nellore'], priority: 84 },
  { name: 'VIT Vellore', domain: 'vit.ac.in', country: 'India', city: 'Vellore', aliases: ['Vellore Institute of Technology'], priority: 100 },
  { name: 'VIT Chennai', domain: 'chennai.vit.ac.in', country: 'India', city: 'Chennai', aliases: ['Vellore Institute of Technology Chennai'], priority: 96 },
  { name: 'IIT Delhi', domain: 'iitd.ac.in', country: 'India', city: 'New Delhi', aliases: ['Indian Institute of Technology Delhi'], priority: 98 },
  { name: 'IIT Bombay', domain: 'iitb.ac.in', country: 'India', city: 'Mumbai', aliases: ['Indian Institute of Technology Bombay'], priority: 98 },
  { name: 'IIT Madras', domain: 'iitm.ac.in', country: 'India', city: 'Chennai', aliases: ['Indian Institute of Technology Madras'], priority: 98 },
  { name: 'IIT Kanpur', domain: 'iitk.ac.in', country: 'India', city: 'Kanpur', aliases: ['Indian Institute of Technology Kanpur'], priority: 96 },
  { name: 'IIT Kharagpur', domain: 'iitkgp.ac.in', country: 'India', city: 'Kharagpur', aliases: ['Indian Institute of Technology Kharagpur'], priority: 96 },
  { name: 'IIT Roorkee', domain: 'iitr.ac.in', country: 'India', city: 'Roorkee', aliases: ['Indian Institute of Technology Roorkee'], priority: 95 },
  { name: 'IIT Guwahati', domain: 'iitg.ac.in', country: 'India', city: 'Guwahati', aliases: ['Indian Institute of Technology Guwahati'], priority: 94 },
  { name: 'IIT Hyderabad', domain: 'iith.ac.in', country: 'India', city: 'Hyderabad', aliases: ['Indian Institute of Technology Hyderabad'], priority: 94 },
  { name: 'IIT BHU', domain: 'iitbhu.ac.in', country: 'India', city: 'Varanasi', aliases: ['Indian Institute of Technology BHU', 'IIT Varanasi'], priority: 94 },
  { name: 'IIT Indore', domain: 'iiti.ac.in', country: 'India', city: 'Indore', aliases: ['Indian Institute of Technology Indore'], priority: 90 },
  { name: 'IIT Ropar', domain: 'iitrpr.ac.in', country: 'India', city: 'Rupnagar', aliases: ['Indian Institute of Technology Ropar'], priority: 90 },
  { name: 'NIT Trichy', domain: 'nitt.edu', country: 'India', city: 'Tiruchirappalli', aliases: ['National Institute of Technology Tiruchirappalli'], priority: 96 },
  { name: 'NIT Warangal', domain: 'nitw.ac.in', country: 'India', city: 'Warangal', aliases: ['National Institute of Technology Warangal'], priority: 95 },
  { name: 'NIT Surathkal', domain: 'nitk.ac.in', country: 'India', city: 'Surathkal', aliases: ['National Institute of Technology Karnataka'], priority: 95 },
  { name: 'NIT Rourkela', domain: 'nitrkl.ac.in', country: 'India', city: 'Rourkela', aliases: ['National Institute of Technology Rourkela'], priority: 94 },
  { name: 'NIT Calicut', domain: 'nitc.ac.in', country: 'India', city: 'Kozhikode', aliases: ['National Institute of Technology Calicut'], priority: 92 },
  { name: 'NIT Durgapur', domain: 'nitdgp.ac.in', country: 'India', city: 'Durgapur', aliases: ['National Institute of Technology Durgapur'], priority: 90 },
  { name: 'BITS Pilani', domain: 'bits-pilani.ac.in', country: 'India', city: 'Pilani', aliases: ['Birla Institute of Technology and Science Pilani'], priority: 96 },
  { name: 'BITS Goa', domain: 'bits-pilani.ac.in', country: 'India', city: 'Goa', aliases: ['BITS Pilani Goa Campus'], priority: 90 },
  { name: 'BITS Hyderabad', domain: 'bits-pilani.ac.in', country: 'India', city: 'Hyderabad', aliases: ['BITS Pilani Hyderabad Campus'], priority: 90 },
  { name: 'IIIT Hyderabad', domain: 'iiit.ac.in', country: 'India', city: 'Hyderabad', aliases: ['International Institute of Information Technology Hyderabad'], priority: 95 },
  { name: 'IIIT Delhi', domain: 'iiitd.ac.in', country: 'India', city: 'New Delhi', aliases: ['Indraprastha Institute of Information Technology Delhi'], priority: 93 },
  { name: 'IIIT Bangalore', domain: 'iiitb.ac.in', country: 'India', city: 'Bengaluru', aliases: ['International Institute of Information Technology Bangalore'], priority: 92 },
  { name: 'IIIT Allahabad', domain: 'iiita.ac.in', country: 'India', city: 'Prayagraj', aliases: ['Indian Institute of Information Technology Allahabad'], priority: 90 },
  { name: 'Delhi Technological University', domain: 'dtu.ac.in', country: 'India', city: 'New Delhi', aliases: ['DTU Delhi'], priority: 92 },
  { name: 'Netaji Subhas University of Technology', domain: 'nsut.ac.in', country: 'India', city: 'New Delhi', aliases: ['NSUT Delhi', 'NSIT Delhi'], priority: 91 },
  { name: 'Jadavpur University', domain: 'jaduniv.edu.in', country: 'India', city: 'Kolkata', priority: 90 },
  { name: 'Anna University', domain: 'annauniv.edu', country: 'India', city: 'Chennai', priority: 90 },
  { name: 'SRM Institute of Science and Technology', domain: 'srmist.edu.in', country: 'India', city: 'Chennai', aliases: ['SRM University'], priority: 88 },
  { name: 'Manipal Institute of Technology', domain: 'manipal.edu', country: 'India', city: 'Manipal', aliases: ['MIT Manipal'], priority: 88 },
  { name: 'PES University', domain: 'pes.edu', country: 'India', city: 'Bengaluru', priority: 87 },
  { name: 'RV College of Engineering', domain: 'rvce.edu.in', country: 'India', city: 'Bengaluru', aliases: ['RVCE Bengaluru'], priority: 87 },
  { name: 'BMS College of Engineering', domain: 'bmsce.ac.in', country: 'India', city: 'Bengaluru', aliases: ['BMSCE Bengaluru'], priority: 86 },
  { name: 'Christ University', domain: 'christuniversity.in', country: 'India', city: 'Bengaluru', priority: 86 },
  { name: 'Amity University', domain: 'amity.edu', country: 'India', city: 'Noida', priority: 85 },
  { name: 'Lovely Professional University', domain: 'lpu.in', country: 'India', city: 'Phagwara', aliases: ['LPU'], priority: 84 },
  { name: 'Chandigarh University', domain: 'cuchd.in', country: 'India', city: 'Mohali', priority: 84 },
  { name: 'University of Delhi', domain: 'du.ac.in', country: 'India', city: 'New Delhi', aliases: ['Delhi University', 'DU'], priority: 88 },
  { name: 'Jawaharlal Nehru University', domain: 'jnu.ac.in', country: 'India', city: 'New Delhi', aliases: ['JNU'], priority: 85 },
  { name: 'University of Mumbai', domain: 'mu.ac.in', country: 'India', city: 'Mumbai', priority: 84 },
  { name: 'Savitribai Phule Pune University', domain: 'unipune.ac.in', country: 'India', city: 'Pune', aliases: ['Pune University'], priority: 84 },
  { name: 'Osmania University', domain: 'osmania.ac.in', country: 'India', city: 'Hyderabad', priority: 84 },
  { name: 'MIT', domain: 'mit.edu', country: 'United States', city: 'Cambridge', aliases: ['Massachusetts Institute of Technology'], priority: 88 },
  { name: 'Stanford University', domain: 'stanford.edu', country: 'United States', city: 'Stanford', priority: 88 },
  { name: 'Harvard University', domain: 'harvard.edu', country: 'United States', city: 'Cambridge', priority: 86 },
  { name: 'University of California, Berkeley', domain: 'berkeley.edu', country: 'United States', city: 'Berkeley', aliases: ['UC Berkeley'], priority: 86 },
  { name: 'Carnegie Mellon University', domain: 'cmu.edu', country: 'United States', city: 'Pittsburgh', aliases: ['CMU'], priority: 86 },
  { name: 'University of Oxford', domain: 'ox.ac.uk', country: 'United Kingdom', city: 'Oxford', priority: 84 },
  { name: 'University of Cambridge', domain: 'cam.ac.uk', country: 'United Kingdom', city: 'Cambridge', priority: 84 },
];

export function normalizeCollegeQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

export function normalizeCollegeKey(value: unknown): string {
  return normalizeCollegeQuery(value).toLowerCase();
}

export function buildCollegeLogoUrl(domain?: string | null): string | null {
  const normalizedDomain = normalizeCollegeQuery(domain || '').toLowerCase();
  if (!normalizedDomain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalizedDomain)) {
    return null;
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(normalizedDomain)}&sz=128`;
}

export async function fetchCollegeLogoImage(
  domain: string
): Promise<{ data: Buffer; contentType: string } | null> {
  const logoUrl = buildCollegeLogoUrl(domain);
  if (!logoUrl) return null;

  try {
    const response = await requestWithBreaker<ArrayBuffer>('google_favicon', 'fetch_college_logo', {
      method: 'GET',
      url: logoUrl,
      timeout: COLLEGE_LOGO_TIMEOUT_MILLIS,
      responseType: 'arraybuffer',
      maxRedirects: 4,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Vormex/1.0 college-logo-proxy',
      },
      validateStatus: (status) => status >= 200 && status < 300,
    }, { connectTimeoutMs: 3_000, requestTimeoutMs: COLLEGE_LOGO_TIMEOUT_MILLIS });
    const contentType = String(response.headers['content-type'] || 'image/png').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    return {
      data: Buffer.from(response.data),
      contentType,
    };
  } catch (error: any) {
    const status = error?.response?.status;
    const detail = status ? `HTTP ${status}` : error?.message || error;
    console.warn(`College logo proxy failed for "${domain}":`, detail);
    return null;
  }
}

export function fallbackInstitutionDomain(name: string, kind?: string | null): string | null {
  const text = `${name} ${kind || ''}`.toLowerCase();
  if (/\bnarayana\b/.test(text)) {
    if (text.includes('junior') || text.includes('inter') || text.includes('intermediate') || text.includes('puc')) {
      return 'narayanajuniorcolleges.com';
    }
    if (text.includes('school')) {
      return 'narayanaschools.in';
    }
    return 'narayanagroup.com';
  }
  if (/\bsri\s+chaitanya\b|\bchaitanya\b/.test(text)) {
    if (text.includes('junior') || text.includes('inter') || text.includes('intermediate') || text.includes('puc')) {
      return 'srichaitanya.net';
    }
    if (text.includes('school')) {
      return 'srichaitanyaschool.net';
    }
    return 'srichaitanya.net';
  }

  return null;
}

export function buildInstitutionLogoUrl(name: string, domain?: string | null, kind?: string | null): string | null {
  return buildCollegeLogoUrl(domain) || buildCollegeLogoUrl(fallbackInstitutionDomain(name, kind));
}

function entrySearchText(entry: CollegeCatalogEntry): string {
  return [entry.name, ...(entry.aliases || []), entry.city, entry.country]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function entryMatchesQuery(entry: CollegeCatalogEntry, query: string): boolean {
  if (!query) return true;
  const normalizedQuery = query.toLowerCase();
  return entrySearchText(entry).includes(normalizedQuery);
}

function scoreCatalogEntry(entry: CollegeCatalogEntry, query: string): number {
  const normalizedQuery = query.toLowerCase();
  const names = [entry.name, ...(entry.aliases || [])].map((value) => value.toLowerCase());
  const base = entry.priority || 0;
  if (!normalizedQuery) return base;
  if (names.some((name) => name === normalizedQuery)) return base + 500;
  if (names.some((name) => name.startsWith(normalizedQuery))) return base + 300;
  if (names.some((name) => name.includes(normalizedQuery))) return base + 150;
  return base;
}

export function toSuggestion(
  entry: CollegeCatalogEntry,
  source: CollegeSuggestionSource,
  count = 0
): CollegeSuggestion {
  const domain = entry.domain || fallbackInstitutionDomain(entry.name, entry.kind);
  return {
    id: null,
    name: entry.name,
    count,
    logoUrl: buildInstitutionLogoUrl(entry.name, domain, entry.kind),
    domain,
    country: entry.country || null,
    state: null,
    city: entry.city || null,
    kind: entry.kind || 'School',
    source,
  };
}

export function findCatalogMatchByName(name: string): CollegeCatalogEntry | null {
  const normalizedName = normalizeCollegeKey(name);
  if (!normalizedName) return null;
  return COLLEGE_CATALOG.find((entry) => {
    const names = [entry.name, ...(entry.aliases || [])].map(normalizeCollegeKey);
    return names.includes(normalizedName);
  }) || null;
}

export function searchCatalogColleges(query: string, limit: number): CollegeSuggestion[] {
  const normalizedQuery = normalizeCollegeQuery(query);
  return COLLEGE_CATALOG
    .filter((entry) => entryMatchesQuery(entry, normalizedQuery))
    .sort((left, right) => {
      const scoreDelta = scoreCatalogEntry(right, normalizedQuery) - scoreCatalogEntry(left, normalizedQuery);
      return scoreDelta || left.name.localeCompare(right.name);
    })
    .slice(0, limit)
    .map((entry) => toSuggestion(entry, 'catalog'));
}
