import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { hashEmail, normalizeEmail } from '../utils/email-hash.util';

type ConnectionState = 'none' | 'pending_sent' | 'pending_received' | 'connected';

interface ContactImportItem {
  name?: string | null;
  email?: string | null;
}

interface PeopleYouKnowMatch {
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
  connectionStatus: ConnectionState;
  mutualConnections: number;
  contactName: string | null;
  isInContacts: true;
}

interface PeopleYouKnowInvite {
  id: string;
  contactName: string | null;
  invitedAt: string | null;
}

interface PeopleYouKnowResponse {
  lastSyncedAt: string | null;
  matched: PeopleYouKnowMatch[];
  invites: PeopleYouKnowInvite[];
  stats: {
    totalContacts: number;
    matchedCount: number;
    inviteCount: number;
  };
}

const MATCH_STATUS_MATCHED = 'matched';
const MATCH_STATUS_UNMATCHED = 'unmatched';

const statusPriority: Record<ConnectionState, number> = {
  none: 0,
  pending_received: 1,
  pending_sent: 2,
  connected: 3,
};

async function ensureUserEmailHashes(): Promise<void> {
  const usersMissingHashes = await prisma.user.findMany({
    where: { emailHash: null },
    select: { id: true, email: true },
  });

  if (usersMissingHashes.length === 0) {
    return;
  }

  await Promise.all(
    usersMissingHashes.map((user) =>
      prisma.user.update({
        where: { id: user.id },
        data: { emailHash: hashEmail(user.email) },
      })
    )
  );
}

async function buildConnectionMetadata(currentUserId: string, targetUserIds: string[]) {
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

async function buildPeopleYouKnowResponse(
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

  const matchedUsers = matchedUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: matchedUserIds } },
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
      matchedCount: sync.matchedCount,
      inviteCount: sync.inviteCount,
    },
  };
}

export const getPeopleYouKnow = async (
  req: AuthenticatedRequest,
  res: Response<PeopleYouKnowResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const sync = await prisma.contactSync.findUnique({
      where: { userId: currentUserId },
      select: {
        id: true,
        lastSyncedAt: true,
        totalCount: true,
        matchedCount: true,
        inviteCount: true,
      },
    });

    if (!sync) {
      res.status(200).json({
        lastSyncedAt: null,
        matched: [],
        invites: [],
        stats: {
          totalContacts: 0,
          matchedCount: 0,
          inviteCount: 0,
        },
      });
      return;
    }

    const response = await buildPeopleYouKnowResponse(currentUserId, sync);
    res.status(200).json(response);
  } catch (error) {
    console.error('Error getting people you know:', error);
    res.status(500).json({ error: 'Failed to load people you know' });
  }
};

export const importPeopleYouKnow = async (
  req: AuthenticatedRequest,
  res: Response<PeopleYouKnowResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const source =
      typeof req.body?.source === 'string' && req.body.source.trim()
        ? req.body.source.trim().toLowerCase()
        : 'picker';
    const contacts: ContactImportItem[] = Array.isArray(req.body?.contacts)
      ? req.body.contacts
      : [];

    if (contacts.length === 0) {
      res.status(400).json({ error: 'No people to discover were provided' });
      return;
    }

    await ensureUserEmailHashes();

    const currentUser = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { email: true, emailHash: true },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const currentUserEmailHash =
      currentUser.emailHash ?? hashEmail(currentUser.email);

    if (!currentUser.emailHash && currentUserEmailHash) {
      await prisma.user.update({
        where: { id: currentUserId },
        data: { emailHash: currentUserEmailHash },
      });
    }

    const entriesByEmailHash = new Map<
      string,
      { contactName: string | null; emailHash: string }
    >();

    for (const contact of contacts) {
      const normalizedEmail = normalizeEmail(contact.email);
      if (!normalizedEmail) continue;

      const emailHash = hashEmail(normalizedEmail);
      if (!emailHash || emailHash === currentUserEmailHash) continue;

      const trimmedName =
        typeof contact.name === 'string' && contact.name.trim()
          ? contact.name.trim()
          : null;

      const existing = entriesByEmailHash.get(emailHash);
      if (!existing || (!existing.contactName && trimmedName)) {
        entriesByEmailHash.set(emailHash, {
          contactName: trimmedName,
          emailHash,
        });
      }
    }

    if (entriesByEmailHash.size === 0) {
      res.status(400).json({ error: 'No valid people were found to discover' });
      return;
    }

    const discoveredUsers = await prisma.user.findMany({
      where: {
        emailHash: { in: Array.from(entriesByEmailHash.keys()) },
      },
      select: {
        id: true,
        emailHash: true,
      },
    });

    const matchedUserIdByHash = new Map(
      discoveredUsers
        .filter((user) => Boolean(user.emailHash))
        .map((user) => [user.emailHash as string, user.id])
    );

    const sync = await prisma.contactSync.upsert({
      where: { userId: currentUserId },
      create: {
        userId: currentUserId,
        lastSyncedAt: new Date(),
        status: 'ready',
      },
      update: {
        lastSyncedAt: new Date(),
        status: 'ready',
      },
      select: { id: true },
    });

    await prisma.contactSyncEntry.deleteMany({
      where: { syncId: sync.id },
    });

    const entries = Array.from(entriesByEmailHash.values()).map((entry) => {
      const matchedUserId = matchedUserIdByHash.get(entry.emailHash) ?? null;
      return {
        syncId: sync.id,
        contactName: entry.contactName,
        emailHash: entry.emailHash,
        matchStatus: matchedUserId ? MATCH_STATUS_MATCHED : MATCH_STATUS_UNMATCHED,
        matchedUserId,
        source,
      };
    });

    await prisma.contactSyncEntry.createMany({
      data: entries,
    });

    const matchedCount = entries.filter(
      (entry) => entry.matchStatus === MATCH_STATUS_MATCHED
    ).length;
    const inviteCount = entries.length - matchedCount;

    const updatedSync = await prisma.contactSync.update({
      where: { id: sync.id },
      data: {
        lastSyncedAt: new Date(),
        matchedCount,
        inviteCount,
        totalCount: entries.length,
        status: 'ready',
      },
      select: {
        id: true,
        lastSyncedAt: true,
        totalCount: true,
        matchedCount: true,
        inviteCount: true,
      },
    });

    const response = await buildPeopleYouKnowResponse(currentUserId, updatedSync);
    res.status(200).json(response);
  } catch (error) {
    console.error('Error importing people you know:', error);
    res.status(500).json({ error: 'Failed to discover people you know' });
  }
};

export const clearPeopleYouKnow = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const existingSync = await prisma.contactSync.findUnique({
      where: { userId: currentUserId },
      select: { id: true },
    });

    if (existingSync) {
      await prisma.contactSync.delete({
        where: { userId: currentUserId },
      });
    }

    res.status(200).json({ message: 'People you know list cleared' });
  } catch (error) {
    console.error('Error clearing people you know:', error);
    res.status(500).json({ error: 'Failed to clear people you know' });
  }
};

export const markPeopleYouKnowInviteSent = async (
  req: AuthenticatedRequest,
  res: Response<{ invitedAt: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const entryId = String(req.params.entryId);

    const entry = await prisma.contactSyncEntry.findFirst({
      where: {
        id: entryId,
        sync: {
          userId: currentUserId,
        },
      },
      select: {
        id: true,
        invitedAt: true,
      },
    });

    if (!entry) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    const invitedAt = entry.invitedAt ?? new Date();
    const updatedEntry = await prisma.contactSyncEntry.update({
      where: { id: entry.id },
      data: { invitedAt },
      select: { invitedAt: true },
    });

    res.status(200).json({
      invitedAt: updatedEntry.invitedAt!.toISOString(),
    });
  } catch (error) {
    console.error('Error marking people you know invite:', error);
    res.status(500).json({ error: 'Failed to update invite state' });
  }
};
