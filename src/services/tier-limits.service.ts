import { prisma } from '../config/prisma';
import { getPremiumAccessSnapshot } from './premium-access.service';

export const FREE_CONNECTION_REQUESTS_PER_DAY = 10;
export const FREE_HACKATHON_TEAM_APPLICATIONS_PER_MONTH = 3;
export const FREE_PROFILE_PROJECT_LIMIT = 3;
export const PREMIUM_PROFILE_PROJECT_LIMIT = 10;

export interface LimitState {
  allowed: boolean;
  isPremium: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  windowStart?: Date;
}

export function getMonthlyUsageWindowStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function getDailyUsageWindowStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function getConnectionRequestLimitState(userId: string): Promise<LimitState> {
  const snapshot = await getPremiumAccessSnapshot(userId);
  const isPremium = snapshot.isPremium || snapshot.user.isAdmin;
  const windowStart = getDailyUsageWindowStart();

  if (isPremium) {
    return {
      allowed: true,
      isPremium: true,
      limit: null,
      used: 0,
      remaining: null,
      windowStart,
    };
  }

  const used = await prisma.connections.count({
    where: {
      requesterId: userId,
      createdAt: {
        gte: windowStart,
      },
    },
  });

  return {
    allowed: used < FREE_CONNECTION_REQUESTS_PER_DAY,
    isPremium: false,
    limit: FREE_CONNECTION_REQUESTS_PER_DAY,
    used,
    remaining: Math.max(0, FREE_CONNECTION_REQUESTS_PER_DAY - used),
    windowStart,
  };
}

export async function getProfileProjectLimitState(userId: string): Promise<LimitState> {
  const snapshot = await getPremiumAccessSnapshot(userId);
  const isPremium = snapshot.isPremium || snapshot.user.isAdmin;
  const limit = isPremium ? PREMIUM_PROFILE_PROJECT_LIMIT : FREE_PROFILE_PROJECT_LIMIT;
  const used = await prisma.project.count({ where: { userId } });

  return {
    allowed: used < limit,
    isPremium,
    limit,
    used,
    remaining: Math.max(0, limit - used),
  };
}

export async function getHackathonTeamApplicationLimitState(userId: string): Promise<LimitState> {
  const snapshot = await getPremiumAccessSnapshot(userId);
  const isPremium = snapshot.isPremium || snapshot.user.isAdmin;
  const windowStart = getMonthlyUsageWindowStart();

  if (isPremium) {
    return {
      allowed: true,
      isPremium: true,
      limit: null,
      used: 0,
      remaining: null,
      windowStart,
    };
  }

  const used = await prisma.hackathon_team_applications.count({
    where: {
      applicantId: userId,
      createdAt: {
        gte: windowStart,
      },
    },
  });

  return {
    allowed: used < FREE_HACKATHON_TEAM_APPLICATIONS_PER_MONTH,
    isPremium: false,
    limit: FREE_HACKATHON_TEAM_APPLICATIONS_PER_MONTH,
    used,
    remaining: Math.max(0, FREE_HACKATHON_TEAM_APPLICATIONS_PER_MONTH - used),
    windowStart,
  };
}
