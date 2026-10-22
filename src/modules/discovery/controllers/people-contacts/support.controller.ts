import { prisma } from "../../../../config/prisma";
import { hashEmail } from "../../../../shared/utils/email-hash.util";
import { Prisma } from "@prisma/client";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { discoverableUsersWhere } from "../../../safety/services/safety-policy";

export type ConnectionState = 'none' | 'pending_sent' | 'pending_received' | 'connected';

export interface ContactImportItem {
  name?: string | null;
  email?: string | null;
}

export interface PeopleYouKnowMatch {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  bannerImageUrl: string | null;
  headline: string | null;
  college: string | null;
  branch: string | null;
  bio: string | null;
  skills: string[];
  interests: string[];
  isOnline: boolean;
  verified: boolean;
  isVerified: boolean;
  connectionStatus: ConnectionState;
  mutualConnections: number;
  contactName: string | null;
  isInContacts: true;
}

export interface PeopleYouKnowInvite {
  id: string;
  contactName: string | null;
  invitedAt: string | null;
}

export interface PeopleYouKnowResponse {
  lastSyncedAt: string | null;
  matched: PeopleYouKnowMatch[];
  invites: PeopleYouKnowInvite[];
  stats: {
    totalContacts: number;
    matchedCount: number;
    inviteCount: number;
  };
}

export const MATCH_STATUS_MATCHED = 'matched';

export const MATCH_STATUS_UNMATCHED = 'unmatched';

export const EMAIL_HASH_BACKFILL_BATCH_SIZE = 500;

export const statusPriority: Record<ConnectionState, number> = {
  none: 0,
  pending_received: 1,
  pending_sent: 2,
  connected: 3,
};

export async function ensureUserEmailHashes(): Promise<void> {
  const usersMissingHashes = await prisma.user.findMany({
    where: { emailHash: null },
    select: { id: true, email: true },
    take: EMAIL_HASH_BACKFILL_BATCH_SIZE,
  });

  if (usersMissingHashes.length === 0) {
    return;
  }

  const updates = usersMissingHashes
    .map((user) => ({
      id: user.id,
      emailHash: hashEmail(user.email),
    }))
    .filter(
      (update): update is { id: string; emailHash: string } =>
        Boolean(update.emailHash)
    );

  if (updates.length === 0) {
    return;
  }

  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "users" AS u
      SET "emailHash" = v."emailHash",
          "updatedAt" = NOW()
      FROM (
        VALUES ${Prisma.join(
          updates.map((update) => Prisma.sql`(${update.id}, ${update.emailHash})`)
        )}
      ) AS v("id", "emailHash")
      WHERE u."id" = v."id"
        AND u."emailHash" IS NULL
    `
  );
}

export async function buildConnectionMetadata(currentUserId: string, targetUserIds: string[]) {
  const uniqueTargetIds = Array.from(new Set(targetUserIds));
  const connectionStatusMap = new Map<string, ConnectionState>();
  const mutualConnectionsMap = new Map<string, number>(
    uniqueTargetIds.map((id) => [id, 0])
  );

  if (uniqueTargetIds.length === 0) {
    return { connectionStatusMap, mutualConnectionsMap };
  }

  const currentUserConnections = await prisma.connections.findMany({
    where: {
      OR: [{ requesterId: currentUserId }, { addresseeId: currentUserId }],
    },
    select: {
      requesterId: true,
      addresseeId: true,
      status: true,
    },
  });

  const acceptedConnectionIds = new Set<string>();

  for (const connection of currentUserConnections) {
    const otherUserId =
      connection.requesterId === currentUserId
        ? connection.addresseeId
        : connection.requesterId;

    if (connection.status === 'accepted') {
      connectionStatusMap.set(otherUserId, 'connected');
      acceptedConnectionIds.add(otherUserId);
      continue;
    }

    if (connection.status === 'pending') {
      connectionStatusMap.set(
        otherUserId,
        connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received'
      );
    }
  }

  if (acceptedConnectionIds.size === 0) {
    return { connectionStatusMap, mutualConnectionsMap };
  }

  const relatedAcceptedConnections = await prisma.connections.findMany({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: { in: uniqueTargetIds } },
        { addresseeId: { in: uniqueTargetIds } },
      ],
    },
    select: {
      requesterId: true,
      addresseeId: true,
    },
  });

  const targetSet = new Set(uniqueTargetIds);
  const buckets = new Map<string, Set<string>>(
    uniqueTargetIds.map((targetUserId) => [targetUserId, new Set<string>()])
  );

  for (const connection of relatedAcceptedConnections) {
    if (targetSet.has(connection.requesterId)) {
      buckets.get(connection.requesterId)?.add(connection.addresseeId);
    }

    if (targetSet.has(connection.addresseeId)) {
      buckets.get(connection.addresseeId)?.add(connection.requesterId);
    }
  }

  for (const [targetUserId, connectedIds] of buckets.entries()) {
    let mutualCount = 0;

    connectedIds.forEach((connectedId) => {
      if (acceptedConnectionIds.has(connectedId)) {
        mutualCount += 1;
      }
    });

    mutualConnectionsMap.set(targetUserId, mutualCount);
  }

  return { connectionStatusMap, mutualConnectionsMap };
}

export async function buildPeopleYouKnowResponse(
  currentUserId: string,
  sync: {
    id: string;
    lastSyncedAt: Date;
    totalCount: number;
    matchedCount: number;
    inviteCount: number;
  }
): Promise<PeopleYouKnowResponse> {
  const entries = await prisma.contactSyncEntry.findMany({
    where: { syncId: sync.id },
    orderBy: [{ invitedAt: 'asc' }, { contactName: 'asc' }, { createdAt: 'asc' }],
  });

  const matchedEntries = entries.filter(
    (entry) => entry.matchStatus === MATCH_STATUS_MATCHED && entry.matchedUserId
  );
  const matchedUserIds = matchedEntries
    .map((entry) => entry.matchedUserId)
    .filter((value): value is string => Boolean(value));

  // Read-time policy: contact matches may have been blocked/banned/suspended
  // since the sync, so re-apply discovery rules on every read.
  const blockedUserIds = matchedUserIds.length ? await getBlockedUserIds(currentUserId) : [];
  const discoverable = discoverableUsersWhere(currentUserId, blockedUserIds);

  const matchedUsers = matchedUserIds.length
    ? await prisma.user.findMany({
        where: { ...discoverable, id: { in: matchedUserIds, notIn: discoverable.id.notIn } },
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          bannerImageUrl: true,
          headline: true,
          college: true,
          branch: true,
          bio: true,
          interests: true,
          isOnline: true,
          isVerified: true,
          profileBadgeStyle: true,
          lastActiveAt: true,
          skills: {
            select: { skill: { select: { name: true } } },
          },
        },
      })
    : [];

  const userById = new Map(matchedUsers.map((user) => [user.id, user]));
  const entryByUserId = new Map(
    matchedEntries
      .filter((entry) => entry.matchedUserId)
      .map((entry) => [entry.matchedUserId as string, entry])
  );

  const { connectionStatusMap, mutualConnectionsMap } = await buildConnectionMetadata(
    currentUserId,
    matchedUserIds
  );

  const matched: PeopleYouKnowMatch[] = matchedUsers
    .map((user) => {
      const entry = entryByUserId.get(user.id);
      const connectionStatus = connectionStatusMap.get(user.id) ?? 'none';
      return {
        id: user.id,
        username: user.username,
        name: user.name,
        profileImage: user.profileImage,
        bannerImageUrl: user.bannerImageUrl,
        headline: user.headline,
        college: user.college,
        branch: user.branch,
        bio: user.bio,
        skills: user.skills.map((skill) => skill.skill.name),
        interests: user.interests,
        isOnline: user.isOnline,
        verified: Boolean(user.isVerified),
        isVerified: Boolean(user.isVerified),
        profileBadgeStyle: user.profileBadgeStyle ?? null,
        connectionStatus,
        mutualConnections: mutualConnectionsMap.get(user.id) ?? 0,
        contactName: entry?.contactName ?? null,
        isInContacts: true as const,
      };
    })
    .sort((left, right) => {
      const connectionDelta =
        statusPriority[left.connectionStatus] - statusPriority[right.connectionStatus];

      if (connectionDelta !== 0) {
        return connectionDelta;
      }

      const mutualDelta = right.mutualConnections - left.mutualConnections;
      if (mutualDelta !== 0) {
        return mutualDelta;
      }

      const leftActiveAt = userById.get(left.id)?.lastActiveAt?.getTime() ?? 0;
      const rightActiveAt = userById.get(right.id)?.lastActiveAt?.getTime() ?? 0;
      return rightActiveAt - leftActiveAt;
    });

  const invites: PeopleYouKnowInvite[] = entries
    .filter((entry) => entry.matchStatus === MATCH_STATUS_UNMATCHED)
    .sort((left, right) => {
      if (!left.invitedAt && right.invitedAt) return -1;
      if (left.invitedAt && !right.invitedAt) return 1;

      const leftName = left.contactName?.toLowerCase() ?? '';
      const rightName = right.contactName?.toLowerCase() ?? '';
      return leftName.localeCompare(rightName);
    })
    .map((entry) => ({
      id: entry.id,
      contactName: entry.contactName ?? null,
      invitedAt: entry.invitedAt ? entry.invitedAt.toISOString() : null,
    }));

  return {
    lastSyncedAt: sync.lastSyncedAt.toISOString(),
    matched,
    invites,
    stats: {
      totalContacts: sync.totalCount,
      matchedCount: matched.length,
      inviteCount: sync.inviteCount,
    },
  };
}
