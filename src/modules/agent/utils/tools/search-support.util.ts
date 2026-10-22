
export function sharedInterests(a: string[] = [], b: string[] = []): string[] {
  const target = new Set((b || []).map((item) => item.toLowerCase()));
  return (a || []).filter((item) => target.has(item.toLowerCase()));
}

export const PEOPLE_SEARCH_STOP_WORDS = new Set([
  'people',
  'person',
  'persons',
  'user',
  'users',
  'profile',
  'profiles',
  'peer',
  'peers',
  'show',
  'find',
  'search',
  'open',
  'browse',
  'get',
  'me',
  'my',
  'with',
  'for',
  'who',
  'that',
  'those',
  'some',
  'campus',
  'college',
  'colleges',
]);

export function queryRequestsCurrentUsersCampus(query: string | null | undefined): boolean {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /\b(my|our|same)\s+(campus|college)\b/.test(normalized) ||
    /\bfrom\s+(my|our)\s+(campus|college)\b/.test(normalized) ||
    /\b(on|in)\s+(my|our)\s+(campus|college)\b/.test(normalized) ||
    /\bfrom\s+same\s+(campus|college)\b/.test(normalized)
  );
}

export function buildPeopleSearchTerms(query: string | null | undefined): string[] {
  const normalized = String(query || '').trim();
  if (!normalized) return [];

  const rawTokens = normalized.toLowerCase().match(/[a-z0-9+#.]+/g) || [];
  const keywordTokens = rawTokens.filter(
    (token) => token.length > 1 && !PEOPLE_SEARCH_STOP_WORDS.has(token)
  );
  const terms = normalized.includes(' ')
    ? keywordTokens.length > 0
      ? [normalized, ...keywordTokens]
      : []
    : keywordTokens;

  return Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).slice(0, 8);
}

export function buildPeopleSearchVariants(term: string): string[] {
  const normalized = term.trim();
  if (!normalized) return [];

  const variants = new Set<string>([normalized, normalized.toLowerCase()]);
  variants.add(
    normalized.replace(/\b\w/g, (segment) => segment.toUpperCase())
  );

  return Array.from(variants).filter(Boolean);
}

export function buildPeopleSearchClauses(terms: string[]): any[] {
  const clauses: any[] = [];

  terms.forEach((term) => {
    buildPeopleSearchVariants(term).forEach((variant) => {
      clauses.push(
        { name: { contains: variant, mode: 'insensitive' } },
        { username: { contains: variant, mode: 'insensitive' } },
        { headline: { contains: variant, mode: 'insensitive' } },
        { bio: { contains: variant, mode: 'insensitive' } },
        { college: { contains: variant, mode: 'insensitive' } },
        { branch: { contains: variant, mode: 'insensitive' } },
        { interests: { has: variant } },
        {
          user_onboarding: {
            is: {
              OR: [
                { primaryGoal: { contains: variant, mode: 'insensitive' } },
                { wantToLearn: { has: variant } },
                { canTeach: { has: variant } },
              ],
            },
          },
        }
      );
    });

    clauses.push({
      skills: {
        some: {
          skill: {
            name: { contains: term, mode: 'insensitive' },
          },
        },
      },
    });
  });

  return clauses;
}

export function scoreUserAgainstPeopleSearch(user: any, terms: string[]): number {
  if (terms.length === 0) return 0;

  const normalizedTerms = terms.map((term) => term.toLowerCase());
  const name = String(user.name || '').toLowerCase();
  const username = String(user.username || '').toLowerCase();
  const headline = String(user.headline || '').toLowerCase();
  const bio = String(user.bio || '').toLowerCase();
  const college = String(user.college || '').toLowerCase();
  const branch = String(user.branch || '').toLowerCase();
  const interests: string[] = (user.interests || []).map((item: string) => String(item || '').toLowerCase());
  const skills: string[] = (user.skills || [])
    .map((item: any) => String(item.skill?.name || '').toLowerCase())
    .filter(Boolean);
  const wantToLearn: string[] = (user.user_onboarding?.wantToLearn || []).map((item: string) =>
    String(item || '').toLowerCase()
  );
  const canTeach: string[] = (user.user_onboarding?.canTeach || []).map((item: string) =>
    String(item || '').toLowerCase()
  );
  const primaryGoal = String(user.user_onboarding?.primaryGoal || '').toLowerCase();

  let score = 0;

  normalizedTerms.forEach((term) => {
    if (name.includes(term)) score += 14;
    if (username.includes(term)) score += 12;
    if (headline.includes(term)) score += 14;
    if (bio.includes(term)) score += 8;
    if (college.includes(term)) score += 6;
    if (branch.includes(term)) score += 6;
    if (primaryGoal.includes(term)) score += 8;
    if (skills.some((item) => item.includes(term))) score += 20;
    if (interests.some((item) => item.includes(term))) score += 18;
    if (wantToLearn.some((item) => item.includes(term))) score += 12;
    if (canTeach.some((item) => item.includes(term))) score += 12;
  });

  return score;
}

export function calculateDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}
