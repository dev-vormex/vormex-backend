import { createHash } from 'crypto';
import { prisma } from '../config/prisma';
import { getBlockedUserIds } from './trust-safety.service';
import { getPeopleRelationshipCapabilities } from './people-relationship.service';
import { dateDescKeysetWhere, decodeKeysetCursor, encodeKeysetCursor, numberDescDateDescIdDescWhere } from '../utils/keyset-pagination.util';
import { ProximityValidationError } from '../utils/proximity-validation.util';

type HistoryTab = 'today' | 'seven_days';
type HistorySort = 'recent' | 'duration';

export async function getProximityHistory(userId: string, input: {
  tab: HistoryTab; sort: HistorySort; cursor?: string; limit: number; query?: string; relationshipFilters?: string[];
}) {
  const now = new Date(); const query = (input.query || '').trim().slice(0, 80);
  const filterScope = (input.relationshipFilters || []).slice().sort().join(',');
  const scope = `proximity-history:${input.tab}:${input.sort}:${createHash('sha256').update(`${query.toLowerCase()}:${filterScope}`).digest('hex').slice(0, 12)}`;
  const cursor = decodeKeysetCursor(input.cursor, scope);
  if (input.cursor && !cursor) throw new ProximityValidationError('PROXIMITY_INVALID_REQUEST', 'History cursor is invalid');
  const blockedIds = await getBlockedUserIds(userId);
  const targetSearch = query ? { OR: [
    { name: { contains: query, mode: 'insensitive' as const } }, { username: { contains: query, mode: 'insensitive' as const } },
    { college: { contains: query, mode: 'insensitive' as const } }, { headline: { contains: query, mode: 'insensitive' as const } },
    { interests: { has: query } }, { skills: { some: { skill: { name: { contains: query, mode: 'insensitive' as const } } } } },
  ] } : {};
  const eligibleTarget = {
    isBanned: false,
    proximityPreference: { is: { crossedPathsDiscoverable: true } },
    AND: [
      { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lt: now } }] },
      { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lt: now } }] },
      targetSearch,
    ],
  };
  const participant = { OR: [
    { lowerUserId: userId, higherUserId: { notIn: blockedIds }, higherUser: { is: eligibleTarget } },
    { higherUserId: userId, lowerUserId: { notIn: blockedIds }, lowerUser: { is: eligibleTarget } },
  ] };
  const cursorWhere = (input.sort === 'duration'
    ? numberDescDateDescIdDescWhere(cursor, 'accumulatedDurationSeconds', 'lastSeenAt')
    : dateDescKeysetWhere(cursor, 'lastSeenAt')) || {};
  const takeLimit = Math.min(100, input.limit * 3 + 1);
  const rows = await prisma.proximity_encounter_pairs.findMany({
    where: { AND: [participant, { expiresAt: { gt: now } }, input.tab === 'today' ? { lastSeenAt: { gte: new Date(now.getTime() - 86_400_000) } } : {}, cursorWhere] },
    orderBy: input.sort === 'duration' ? [{ accumulatedDurationSeconds: 'desc' }, { lastSeenAt: 'desc' }, { id: 'desc' }] : [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    take: takeLimit, include: {
      lowerUser: { select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true } },
      higherUser: { select: { id: true, username: true, name: true, profileImage: true, headline: true, college: true } },
      userStates: { where: { ownerUserId: userId } },
    },
  });
  const stateVisible = rows.filter((row) => {
    const state = row.userStates[0];
    return !state?.hiddenAt && (!state?.removedAt || row.lastSeenAt > state.removedAt);
  });
  const targetIds = stateVisible.map((row) => row.lowerUserId === userId ? row.higherUserId : row.lowerUserId);
  const capabilities = await getPeopleRelationshipCapabilities(userId, targetIds, {
    includeActionLimits: true,
  });
  const relationshipFilters = new Set(input.relationshipFilters || []);
  const stateVisibleIds = new Set(stateVisible.map((row) => row.id));
  const visible: typeof stateVisible = [];
  let lastScanned: (typeof rows)[number] | undefined;
  let lastScannedIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    lastScanned = row;
    lastScannedIndex = index;
    if (!stateVisibleIds.has(row.id)) continue;
    const targetId = row.lowerUserId === userId ? row.higherUserId : row.lowerUserId;
    if (relationshipFilters.size > 0
      && !relationshipFilters.has(capabilities.get(targetId)?.connectionStatus || 'none')) continue;
    visible.push(row);
    if (visible.length === input.limit) break;
  }
  const items = visible.map((row) => {
    const target = row.lowerUserId === userId ? row.higherUser : row.lowerUser;
    const capability = capabilities.get(target.id) || { connectionStatus: 'none', canConnect: true, canMessage: false, canBlock: true };
    return { encounterId: row.id, user: target, areaLabel: row.areaLabel || 'Approximate area', firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt, accumulatedDurationSeconds: row.accumulatedDurationSeconds, freshnessSeconds: Math.max(0, Math.floor((now.getTime() - row.lastSeenAt.getTime()) / 1000)),
      expiresAt: row.expiresAt, connectionStatus: capability.connectionStatus, actions: { canConnect: capability.canConnect,
        canMessage: capability.canMessage, canBlock: capability.canBlock } };
  });
  const hasMore = Boolean(lastScanned) && (
    lastScannedIndex < rows.length - 1 || rows.length === takeLimit
  );
  return { items, nextCursor: hasMore && lastScanned ? encodeKeysetCursor({ id: lastScanned.id,
    t: lastScanned.lastSeenAt.toISOString(), n: input.sort === 'duration' ? lastScanned.accumulatedDurationSeconds : undefined, scope }) : null };
}

async function pairForOwner(ownerUserId: string, targetUserId: string) {
  return prisma.proximity_encounter_pairs.findFirst({ where: { OR: [
    { lowerUserId: ownerUserId, higherUserId: targetUserId }, { lowerUserId: targetUserId, higherUserId: ownerUserId },
  ] } });
}

export async function removeProximityHistory(ownerUserId: string, targetUserId: string) {
  const pair = await pairForOwner(ownerUserId, targetUserId); if (!pair) return false;
  await prisma.proximity_encounter_user_state.upsert({ where: { encounterId_ownerUserId: { encounterId: pair.id, ownerUserId } },
    create: { encounterId: pair.id, ownerUserId, removedAt: new Date() }, update: { removedAt: new Date() } });
  return true;
}

export async function setProximityHidden(ownerUserId: string, targetUserId: string, hidden: boolean) {
  const pair = await pairForOwner(ownerUserId, targetUserId); if (!pair) return false;
  await prisma.proximity_encounter_user_state.upsert({ where: { encounterId_ownerUserId: { encounterId: pair.id, ownerUserId } },
    create: { encounterId: pair.id, ownerUserId, hiddenAt: hidden ? new Date() : null }, update: { hiddenAt: hidden ? new Date() : null } });
  return true;
}

export async function removeAllProximityHistory(ownerUserId: string) {
  const pairs = await prisma.proximity_encounter_pairs.findMany({ where: { expiresAt: { gt: new Date() }, OR: [{ lowerUserId: ownerUserId }, { higherUserId: ownerUserId }] }, select: { id: true } });
  const now = new Date();
  await prisma.$transaction(pairs.map((pair) => prisma.proximity_encounter_user_state.upsert({
    where: { encounterId_ownerUserId: { encounterId: pair.id, ownerUserId } }, create: { encounterId: pair.id, ownerUserId, removedAt: now }, update: { removedAt: now },
  })));
  return pairs.length;
}
