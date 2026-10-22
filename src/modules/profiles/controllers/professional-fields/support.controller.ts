import { createHash } from "crypto";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { reindexPublicProfile } from "../../../discovery/services/public-discovery.service";

export /**
 * Validation helpers
 */
const PROFICIENCY_LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];

export const EXPERIENCE_TYPES = ['Internship', 'Part-time', 'Full-time', 'Freelance', 'Contract'];

export const ACHIEVEMENT_TYPES = ['Hackathon', 'Competition', 'Award', 'Scholarship', 'Recognition'];

export const SKILL_SEARCH_CACHE_TTL_SECONDS = 5 * 60;

export const SKILL_SEARCH_MAX_LIMIT = 20;

export const skillSearchCacheKey = (query: string, limit: number): string =>
  `skills:search:v1:${createHash('sha256').update(query.toLowerCase()).digest('hex').slice(0, 24)}:${limit}`;

export async function invalidateProfessionalProfileCaches(
  userId: string,
  refreshSearchDocument = false
): Promise<void> {
  await cacheService.invalidateTags(
    `user:${userId}`,
    `people:user:${userId}`,
    ...(refreshSearchDocument ? ['people:global'] : [])
  ).catch((error) => {
    console.warn('Professional profile cache invalidation failed:', error);
  });
  if (refreshSearchDocument) {
    void reindexPublicProfile(userId).catch(() => undefined);
  }
}

export function validateUrl(url: string | null | undefined): boolean {
  if (!url) return true; // Optional field
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function validateDateRange(startDate: Date, endDate: Date | null | undefined, isCurrent: boolean): boolean {
  if (isCurrent || !endDate) return true;
  return startDate <= endDate;
}
