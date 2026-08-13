import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import {
  getPremiumAccessSnapshot,
  isCreatorProSubscriptionActive,
  isPremiumSubscriptionActive,
} from './premium-access.service';

export const PREMIUM_DISCOVERY_PRIORITY = 40;
export const CREATOR_PRO_DISCOVERY_PRIORITY = 90;
export const CREATOR_PRO_SHOWCASE_PRIORITY = 35;
export const PROFILE_BOOST_PRIORITY = 120;
export const PREMIUM_REQUEST_QUEUE_PRIORITY = 30;
export const CREATOR_PRO_REQUEST_QUEUE_PRIORITY = 75;
export const PROFILE_BOOST_REQUEST_QUEUE_PRIORITY = 100;

export interface PremiumVisibilityState {
  userId: string;
  isPremium: boolean;
  creatorProActive: boolean;
  profileBoostActive: boolean;
  profileBoostEndsAt: Date | null;
  profileBoostPriority: number;
  discoveryPriority: number;
  requestQueuePriority: number;
}

export interface PremiumEntitlements {
  connectionRequests: {
    freeLimit: number;
    freeWindow: 'day';
    premiumLimit: null;
    unlimitedForPremium: boolean;
  };
  profileBoost: {
    durationHours: number;
    priority: number;
  };
  priorityDiscovery: boolean;
  featuredFeedPlacement: boolean;
  requestQueuePriority: boolean;
}

type ActiveBoostRow = {
  userId: string;
  priority: number | bigint | null;
  endsAt: Date | string | null;
};

const DEFAULT_PROFILE_BOOST_DURATION_HOURS = 4;
let hasLoggedMissingProfileBoostsTable = false;
let hasLoggedMissingCreatorProSettingsTable = false;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

export function getProfileBoostDurationHours(): number {
  return readPositiveIntEnv(
    'VORMEX_PREMIUM_PROFILE_BOOST_DURATION_HOURS',
    DEFAULT_PROFILE_BOOST_DURATION_HOURS
  );
}

export function getPremiumEntitlements(freeConnectionRequestLimit: number): PremiumEntitlements {
  return {
    connectionRequests: {
      freeLimit: freeConnectionRequestLimit,
      freeWindow: 'day',
      premiumLimit: null,
      unlimitedForPremium: true,
    },
    profileBoost: {
      durationHours: getProfileBoostDurationHours(),
      priority: PROFILE_BOOST_PRIORITY,
    },
    priorityDiscovery: true,
    featuredFeedPlacement: true,
    requestQueuePriority: true,
  };
}

function emptyVisibilityState(userId: string): PremiumVisibilityState {
  return {
    userId,
    isPremium: false,
    creatorProActive: false,
    profileBoostActive: false,
    profileBoostEndsAt: null,
    profileBoostPriority: 0,
    discoveryPriority: 0,
    requestQueuePriority: 0,
  };
}

function uniqueIds(userIds: string[]): string[] {
  return Array.from(
    new Set(userIds.map((id) => String(id || '').trim()).filter(Boolean))
  );
}

function isMissingProfileBoostsTableError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    meta?: { code?: string; message?: string };
    message?: string;
  };
  return (
    candidate?.code === 'P2010' &&
    (
      candidate.meta?.code === '42P01' ||
      String(candidate.meta?.message || candidate.message || '').includes('profile_boosts')
    )
  );
}

function isMissingCreatorProSettingsTableError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    meta?: { code?: string; message?: string; table?: string };
    message?: string;
  };
  return (
    candidate?.code === 'P2021' ||
    (
      candidate?.code === 'P2010' &&
      (
        candidate.meta?.code === '42P01' ||
        String(candidate.meta?.message || candidate.message || '').includes('creator_pro_settings')
      )
    ) ||
    String(candidate.meta?.table || candidate.meta?.message || candidate.message || '').includes('creator_pro_settings')
  );
}

export async function getActiveProfileBoostsByUserIds(
  userIds: string[],
  now = new Date()
): Promise<Map<string, Pick<PremiumVisibilityState, 'profileBoostActive' | 'profileBoostEndsAt' | 'profileBoostPriority'>>> {
  const ids = uniqueIds(userIds);
  const boosts = new Map<string, Pick<PremiumVisibilityState, 'profileBoostActive' | 'profileBoostEndsAt' | 'profileBoostPriority'>>();
  if (ids.length === 0) return boosts;

  const rows = await prisma.$queryRaw<ActiveBoostRow[]>(Prisma.sql`
      SELECT "userId", MAX("priority") AS "priority", MAX("endsAt") AS "endsAt"
      FROM "profile_boosts"
      WHERE "userId" IN (${Prisma.join(ids)})
        AND "status" = 'active'
        AND "startsAt" <= ${now}
        AND "endsAt" > ${now}
      GROUP BY "userId"
    `).catch((error: unknown) => {
      if (isMissingProfileBoostsTableError(error)) {
        if (!hasLoggedMissingProfileBoostsTable) {
          hasLoggedMissingProfileBoostsTable = true;
          console.warn(
            'profile_boosts table is missing; premium profile boosts are disabled until migrations run.'
          );
        }
        return [] as ActiveBoostRow[];
      }
      throw error;
    });

  for (const row of rows) {
    const priority = Number(row.priority || PROFILE_BOOST_PRIORITY);
    boosts.set(row.userId, {
      profileBoostActive: true,
      profileBoostEndsAt: row.endsAt ? new Date(row.endsAt) : null,
      profileBoostPriority: Number.isFinite(priority) ? priority : PROFILE_BOOST_PRIORITY,
    });
  }

  return boosts;
}

export async function getPremiumVisibilityByUserIds(
  userIds: string[],
  now = new Date()
): Promise<Map<string, PremiumVisibilityState>> {
  const ids = uniqueIds(userIds);
  const visibilityByUser = new Map<string, PremiumVisibilityState>();
  ids.forEach((id) => visibilityByUser.set(id, emptyVisibilityState(id)));
  if (ids.length === 0) return visibilityByUser;

  const [subscriptions, activeBoosts, creatorProSettings] = await Promise.all([
    prisma.subscriptions.findMany({
      where: { userId: { in: ids } },
      select: {
        userId: true,
        plan: true,
        status: true,
        provider: true,
        currentPeriodEnd: true,
        cancelledAt: true,
      },
    }),
    getActiveProfileBoostsByUserIds(ids, now),
    prisma.creator_pro_settings.findMany({
      where: { userId: { in: ids } },
      select: {
        userId: true,
        collabPriorityEnabled: true,
        showcaseAmplificationEnabled: true,
        portfolioAmplificationEnabled: true,
      },
    }).catch((error: unknown) => {
      if (isMissingCreatorProSettingsTableError(error)) {
        if (!hasLoggedMissingCreatorProSettingsTable) {
          hasLoggedMissingCreatorProSettingsTable = true;
          console.warn(
            'creator_pro_settings table is missing; Creator Pro ranking extras are disabled until migrations run.'
          );
        }
        return [] as Array<{
          userId: string;
          collabPriorityEnabled: boolean;
          showcaseAmplificationEnabled: boolean;
          portfolioAmplificationEnabled: boolean;
        }>;
      }
      throw error;
    }),
  ]);
  const creatorProSettingsByUser = new Map(
    creatorProSettings.map((settings) => [settings.userId, settings])
  );

  for (const subscription of subscriptions) {
    const isCreatorPro = isCreatorProSubscriptionActive(subscription, now);
    if (!isCreatorPro && !isPremiumSubscriptionActive(subscription, now)) continue;
    const state = visibilityByUser.get(subscription.userId) || emptyVisibilityState(subscription.userId);
    state.isPremium = true;
    if (isCreatorPro) {
      const settings = creatorProSettingsByUser.get(subscription.userId);
      state.creatorProActive = true;
      state.discoveryPriority += PREMIUM_DISCOVERY_PRIORITY;
      if (settings?.collabPriorityEnabled !== false) {
        state.discoveryPriority += CREATOR_PRO_DISCOVERY_PRIORITY;
        state.requestQueuePriority += CREATOR_PRO_REQUEST_QUEUE_PRIORITY;
      }
      if (
        settings?.showcaseAmplificationEnabled !== false ||
        settings?.portfolioAmplificationEnabled !== false
      ) {
        state.discoveryPriority += CREATOR_PRO_SHOWCASE_PRIORITY;
      }
    } else {
      state.discoveryPriority += PREMIUM_DISCOVERY_PRIORITY;
      state.requestQueuePriority += PREMIUM_REQUEST_QUEUE_PRIORITY;
    }
    visibilityByUser.set(subscription.userId, state);
  }

  for (const [userId, boost] of activeBoosts) {
    const state = visibilityByUser.get(userId) || emptyVisibilityState(userId);
    state.profileBoostActive = boost.profileBoostActive;
    state.profileBoostEndsAt = boost.profileBoostEndsAt;
    state.profileBoostPriority = boost.profileBoostPriority;
    state.discoveryPriority += boost.profileBoostPriority;
    state.requestQueuePriority += PROFILE_BOOST_REQUEST_QUEUE_PRIORITY + boost.profileBoostPriority;
    visibilityByUser.set(userId, state);
  }

  return visibilityByUser;
}

export function applyPremiumVisibilityToUser<T extends { id: string }>(
  user: T,
  visibilityByUser: Map<string, PremiumVisibilityState>
): T & {
  isPremium: boolean;
  creatorProActive: boolean;
  profileBoostActive: boolean;
  profileBoostEndsAt: string | null;
  profileBoostPriority: number;
  discoveryPriority: number;
} {
  const visibility = visibilityByUser.get(user.id) || emptyVisibilityState(user.id);
  return {
    ...user,
    isPremium: visibility.isPremium,
    creatorProActive: visibility.creatorProActive,
    profileBoostActive: visibility.profileBoostActive,
    profileBoostEndsAt: visibility.profileBoostEndsAt?.toISOString() || null,
    profileBoostPriority: visibility.profileBoostPriority,
    discoveryPriority: visibility.discoveryPriority,
  };
}

export function sortByPremiumVisibility<T extends { id: string; lastActiveAt?: Date | string | null }>(
  items: T[],
  visibilityByUser: Map<string, PremiumVisibilityState>
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aVisibility = visibilityByUser.get(a.item.id) || emptyVisibilityState(a.item.id);
      const bVisibility = visibilityByUser.get(b.item.id) || emptyVisibilityState(b.item.id);
      if (bVisibility.discoveryPriority !== aVisibility.discoveryPriority) {
        return bVisibility.discoveryPriority - aVisibility.discoveryPriority;
      }

      const aActive = a.item.lastActiveAt ? new Date(a.item.lastActiveAt).getTime() : 0;
      const bActive = b.item.lastActiveAt ? new Date(b.item.lastActiveAt).getTime() : 0;
      if (Number.isFinite(aActive) && Number.isFinite(bActive) && bActive !== aActive) {
        return bActive - aActive;
      }

      return a.index - b.index;
    })
    .map(({ item }) => item);
}

export async function getMyProfileBoostState(userId: string) {
  const [snapshot, visibilityByUser] = await Promise.all([
    getPremiumAccessSnapshot(userId),
    getPremiumVisibilityByUserIds([userId]),
  ]);
  const visibility = visibilityByUser.get(userId) || emptyVisibilityState(userId);

  return {
    active: visibility.profileBoostActive,
    endsAt: visibility.profileBoostEndsAt?.toISOString() || null,
    priority: visibility.profileBoostPriority || PROFILE_BOOST_PRIORITY,
    durationHours: getProfileBoostDurationHours(),
    canActivate: snapshot.isPremium || snapshot.user.isAdmin,
    isPremium: snapshot.isPremium || snapshot.user.isAdmin,
  };
}

export async function activateProfileBoostForUser(
  userId: string,
  options: { durationHours?: number } = {}
) {
  const snapshot = await getPremiumAccessSnapshot(userId);
  if (!snapshot.isPremium && !snapshot.user.isAdmin) {
    return {
      ok: false as const,
      statusCode: 403,
      error: 'Profile boosts are available for Premium users.',
      code: 'premium_required',
    };
  }

  const now = new Date();
  const requestedDuration = options.durationHours || getProfileBoostDurationHours();
  const durationHours = Math.min(24, Math.max(1, Math.round(requestedDuration)));
  const endsAt = new Date(now.getTime() + durationHours * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.$executeRaw(Prisma.sql`
      UPDATE "profile_boosts"
      SET "status" = 'superseded', "updatedAt" = ${now}
      WHERE "userId" = ${userId}
        AND "status" = 'active'
        AND "endsAt" > ${now}
    `),
    prisma.$executeRaw(Prisma.sql`
      INSERT INTO "profile_boosts" (
        "id",
        "userId",
        "source",
        "status",
        "priority",
        "startsAt",
        "endsAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        ${randomUUID()},
        ${userId},
        'premium',
        'active',
        ${PROFILE_BOOST_PRIORITY},
        ${now},
        ${endsAt},
        ${now},
        ${now}
      )
    `),
  ]);

  return {
    ok: true as const,
    boost: {
      active: true,
      startsAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      priority: PROFILE_BOOST_PRIORITY,
      durationHours,
    },
  };
}
