

import { isToday } from "../../utils/streak-date.util";

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export const TOP_NETWORKERS_CACHE_TAG = 'engagement:leaderboard';

export const TOP_NETWORKERS_CACHE_TTL_SECONDS = 300;

export const TOP_NETWORKERS_DEFAULT_LIMIT = 100;

export const TOP_NETWORKERS_MAX_LIMIT = 100;

export // Helper to get start of current week (Monday)
function getWeekStart(): Date {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday = 0
  const weekStart = new Date(now);
  weekStart.setUTCDate(weekStart.getUTCDate() - diff);
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart;
}

export // Helper to check if streak is at risk (no activity today and had streak yesterday)
function checkAtRisk(lastDate: Date | null, currentStreak: number): boolean {
  if (currentStreak === 0) return false;
  if (!lastDate) return false;
  return !isToday(lastDate);
}
