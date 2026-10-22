import type { Prisma } from '@prisma/client';
import { prisma, prismaRead } from "../../../../config/prisma";
import { notificationService } from "../../../notifications/services/notification.service";
import { pushNotificationService } from "../../../notifications/services/push-notification.service";
import { SAVED_SEARCH_FILTER_KEYS, normalizeBoolean, parseNumber, normalizeSearchText, SAVED_SEARCH_MATCH_SCAN_LIMIT } from "./free-discovery-suggestions-per-day.service";
import { buildPeopleDiscoveryWhere } from "./get-nearby-discovery-user-ids.service";

export function sanitizeSavedSearchFilters(input: unknown): Prisma.InputJsonObject {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const filters: { [key: string]: Prisma.InputJsonValue } = {};

  for (const key of SAVED_SEARCH_FILTER_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;

    if (key === 'verifiedOnly' || key === 'isOpenToOpportunities') {
      if (normalizeBoolean(value)) filters[key] = true;
      continue;
    }

    if (key === 'graduationYear' || key === 'radiusKm') {
      const number = parseNumber(value);
      if (number !== null) filters[key] = Math.floor(number);
      continue;
    }

    if (key === 'lat' || key === 'lng') {
      const number = parseNumber(value);
      if (number !== null) filters[key] = number;
      continue;
    }

    const text = normalizeSearchText(value, key === 'search' ? 100 : 160);
    if (text) filters[key] = text;
  }

  return filters;
}

function mapSavedDiscoverySearch(search: any, unseenCount?: number) {
  return {
    id: search.id,
    name: search.name,
    filters: sanitizeSavedSearchFilters(search.filters || {}),
    notificationsEnabled: Boolean(search.notificationsEnabled),
    digestEnabled: Boolean(search.digestEnabled),
    unseenCount: unseenCount ?? search._count?.matches ?? 0,
    lastViewedAt: search.lastViewedAt?.toISOString?.() ?? null,
    lastScannedAt: search.lastScannedAt?.toISOString?.() ?? null,
    lastDigestSentAt: search.lastDigestSentAt?.toISOString?.() ?? null,
    createdAt: search.createdAt?.toISOString?.() ?? null,
    updatedAt: search.updatedAt?.toISOString?.() ?? null,
  };
}

async function findSavedSearchMatchIds(search: any): Promise<string[]> {
  const filters = sanitizeSavedSearchFilters(search.filters || {});
  const { where } = await buildPeopleDiscoveryWhere({
    userId: search.userId,
    query: filters,
    access: { isPremium: true, isAdmin: false },
    applyDefaultLocalScope: filters.scope !== 'global',
  });

  const users = await prismaRead.user.findMany({
    where,
    select: { id: true },
    orderBy: [
      { lastActiveAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ],
    take: SAVED_SEARCH_MATCH_SCAN_LIMIT,
  });

  return users.map((user) => user.id);
}

async function refreshSavedSearchMatches(search: any, options: { seedAsSeen?: boolean } = {}) {
  const targetUserIds = await findSavedSearchMatchIds(search);
  const now = new Date();
  if (targetUserIds.length > 0) {
    await prisma.saved_discovery_search_matches.createMany({
      data: targetUserIds.map((targetUserId) => ({
        savedSearchId: search.id,
        targetUserId,
        seenAt: options.seedAsSeen ? now : null,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.saved_discovery_searches.update({
    where: { id: search.id },
    data: { lastScannedAt: now },
  });

  return targetUserIds.length;
}

export async function listSavedDiscoverySearches(userId: string) {
  const searches = await prismaRead.saved_discovery_searches.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 25,
  });

  await Promise.all(searches.map((search) => refreshSavedSearchMatches(search).catch(() => 0)));

  const refreshed = await prismaRead.saved_discovery_searches.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 25,
    include: {
      _count: {
        select: {
          matches: { where: { seenAt: null } },
        },
      },
    },
  });

  return refreshed.map((search) => mapSavedDiscoverySearch(search));
}

export async function createSavedDiscoverySearch(userId: string, body: any) {
  const filters = sanitizeSavedSearchFilters(body?.filters || body || {});
  const requestedName = normalizeSearchText(body?.name, 80);
  const name = requestedName || normalizeSearchText(filters.search, 40) || 'Discovery search';

  const search = await prisma.saved_discovery_searches.create({
    data: {
      userId,
      name,
      filters,
      notificationsEnabled: body?.notificationsEnabled !== false,
      digestEnabled: body?.digestEnabled !== false,
    },
  });

  await refreshSavedSearchMatches(search, { seedAsSeen: true });

  const refreshed = await prismaRead.saved_discovery_searches.findUnique({
    where: { id: search.id },
    include: {
      _count: {
        select: {
          matches: { where: { seenAt: null } },
        },
      },
    },
  });

  return mapSavedDiscoverySearch(refreshed || search);
}

export async function updateSavedDiscoverySearch(userId: string, searchId: string, body: any) {
  const existing = await prismaRead.saved_discovery_searches.findFirst({
    where: { id: searchId, userId },
  });
  if (!existing) return null;

  if (body?.markViewed === true) {
    const now = new Date();
    await prisma.$transaction([
      prisma.saved_discovery_search_matches.updateMany({
        where: { savedSearchId: searchId, seenAt: null },
        data: { seenAt: now },
      }),
      prisma.saved_discovery_searches.update({
        where: { id: searchId },
        data: { lastViewedAt: now },
      }),
    ]);
  }

  const data: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const name = normalizeSearchText(body.name, 80);
    if (name) data.name = name;
  }
  if (body?.filters !== undefined) {
    data.filters = sanitizeSavedSearchFilters(body.filters);
  }
  if (body?.notificationsEnabled !== undefined) {
    data.notificationsEnabled = Boolean(body.notificationsEnabled);
  }
  if (body?.digestEnabled !== undefined) {
    data.digestEnabled = Boolean(body.digestEnabled);
  }

  const updated = Object.keys(data).length > 0
    ? await prisma.saved_discovery_searches.update({ where: { id: searchId }, data })
    : await prismaRead.saved_discovery_searches.findUnique({ where: { id: searchId } });

  if (body?.filters !== undefined) {
    await prisma.saved_discovery_search_matches.deleteMany({ where: { savedSearchId: searchId } });
    await refreshSavedSearchMatches(updated, { seedAsSeen: true });
  }

  const refreshed = await prismaRead.saved_discovery_searches.findUnique({
    where: { id: searchId },
    include: {
      _count: {
        select: {
          matches: { where: { seenAt: null } },
        },
      },
    },
  });

  return mapSavedDiscoverySearch(refreshed || updated);
}

export async function deleteSavedDiscoverySearch(userId: string, searchId: string): Promise<boolean> {
  const result = await prisma.saved_discovery_searches.deleteMany({
    where: { id: searchId, userId },
  });
  return result.count > 0;
}

export function buildSavedSearchDigestCopy(searchName: string, count: number) {
  const safeName = normalizeSearchText(searchName, 60) || 'your saved search';
  return {
    title: count === 1 ? 'New discovery match' : 'New discovery matches',
    body: count === 1
      ? `1 new person matches ${safeName}`
      : `${count} new people match ${safeName}`,
  };
}

export async function runSavedDiscoverySearchDigest(): Promise<{ processed: number; notified: number }> {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  const searches = await prismaRead.saved_discovery_searches.findMany({
    where: {
      notificationsEnabled: true,
      digestEnabled: true,
      OR: [
        { lastDigestSentAt: null },
        { lastDigestSentAt: { lt: recentCutoff } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 250,
  });

  let notified = 0;
  for (const search of searches) {
    await refreshSavedSearchMatches(search).catch(() => 0);

    const unseenMatches = await prismaRead.saved_discovery_search_matches.findMany({
      where: {
        savedSearchId: search.id,
        seenAt: null,
        digestSentAt: null,
      },
      select: { id: true, targetUserId: true },
      take: 10,
      orderBy: { firstMatchedAt: 'desc' },
    });

    if (unseenMatches.length === 0) continue;

    const copy = buildSavedSearchDigestCopy(search.name, unseenMatches.length);
    const matchedUserIds = unseenMatches.map((match) => match.targetUserId);
    await notificationService.createNotification({
      userId: search.userId,
      type: 'saved_search_digest',
      title: copy.title,
      body: copy.body,
      data: {
        screen: 'find_people',
        route: 'find_people',
        savedSearchId: search.id,
        savedSearchName: search.name,
        matchedUserIds,
        filters: sanitizeSavedSearchFilters(search.filters || {}),
      },
    });

    await pushNotificationService.sendToUser(search.userId, {
      title: copy.title,
      body: copy.body,
      data: {
        type: 'saved_search_digest',
        screen: 'find_people',
        savedSearchId: search.id,
      },
    }).catch(() => undefined);

    await prisma.$transaction([
      prisma.saved_discovery_search_matches.updateMany({
        where: { id: { in: unseenMatches.map((match) => match.id) } },
        data: {
          notifiedAt: now,
          digestSentAt: now,
        },
      }),
      prisma.saved_discovery_searches.update({
        where: { id: search.id },
        data: { lastDigestSentAt: now },
      }),
    ]);
    notified += 1;
  }

  return { processed: searches.length, notified };
}
