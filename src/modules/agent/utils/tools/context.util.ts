import { prisma } from "../../../../config/prisma";
import { evaluateLocationVisibility } from "../../../safety/services/safety-policy";
import { ConnectionState, clip } from "./support.util";
import { sharedInterests } from "./search-support.util";
import { agentUserSelect, agentCurrentUserContextSelect } from "./schemas.util";
import { buildAgentCurrentUserSnapshot, buildAgentCurrentUserPromptContext } from "./prompt.util";

export async function buildConnectionMetadata(currentUserId: string, targetUserIds: string[]) {
  const uniqueTargetIds = Array.from(new Set(targetUserIds.filter(Boolean)));
  const connectionStatusMap = new Map<string, ConnectionState>();
  const mutualConnectionsMap = new Map<string, number>(
    uniqueTargetIds.map((targetUserId) => [targetUserId, 0])
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
  const connectionBuckets = new Map<string, Set<string>>(
    uniqueTargetIds.map((targetUserId) => [targetUserId, new Set<string>()])
  );

  for (const connection of relatedAcceptedConnections) {
    if (targetSet.has(connection.requesterId)) {
      connectionBuckets.get(connection.requesterId)?.add(connection.addresseeId);
    }

    if (targetSet.has(connection.addresseeId)) {
      connectionBuckets.get(connection.addresseeId)?.add(connection.requesterId);
    }
  }

  for (const [targetUserId, connectedIds] of connectionBuckets.entries()) {
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

export function summarizeUser(
  user: any,
  currentUser?: any,
  connectionStatus: ConnectionState = 'none',
  mutualConnections: number = 0
): Record<string, unknown> {
  const overlap = currentUser ? sharedInterests(user.interests || [], currentUser.interests || []) : [];
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    profileImage: user.profileImage || null,
    headline: user.headline || null,
    bio: clip(user.bio, 160),
    college: user.college || null,
    branch: user.branch || null,
    location: evaluateLocationVisibility({
      isOwner: Boolean(currentUser) && currentUser.id === user.id,
      shareLocationPublic: user.shareLocationPublic,
    })
      ? user.location || user.currentCity || null
      : null,
    interests: user.interests || [],
    sharedInterests: overlap,
    skills: (user.skills || []).map((item: any) => item.skill?.name).filter(Boolean),
    isOnline: Boolean(user.isOnline),
    connectionStatus,
    mutualConnections,
    stats: user.userStats
      ? {
          connectionsCount: user.userStats.connectionsCount,
          xp: user.userStats.xp,
          level: user.userStats.level,
        }
      : null,
  };
}

export async function getCurrentUserContext(userId: string): Promise<any> {
  return prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: agentUserSelect,
  });
}

export async function getAgentCurrentUserContext(userId: string): Promise<{
  snapshot: Record<string, unknown>;
  promptContext: string;
} | null> {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: agentCurrentUserContextSelect,
  });

  if (!user) {
    return null;
  }

  const snapshot = buildAgentCurrentUserSnapshot(user);
  return {
    snapshot,
    promptContext: buildAgentCurrentUserPromptContext(snapshot),
  };
}
