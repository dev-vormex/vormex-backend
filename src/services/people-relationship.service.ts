import { prismaRead } from '../config/prisma';
import { getConnectionRequestLimitState } from './tier-limits.service';

export type PeopleConnectionStatus = 'none' | 'pending_sent' | 'pending_received' | 'connected';

export type PeopleRelationshipCapability = {
  connectionStatus: PeopleConnectionStatus;
  canConnect: boolean;
  canMessage: boolean;
  canBlock: boolean;
};

type RelationshipCapabilityOptions = {
  includeActionLimits?: boolean;
};

export async function getPeopleRelationshipCapabilities(
  currentUserId: string,
  targetUserIds: string[],
  options: RelationshipCapabilityOptions = {},
): Promise<Map<string, PeopleRelationshipCapability>> {
  const uniqueIds = Array.from(new Set(targetUserIds.filter((id) => id && id !== currentUserId)));
  const [connectionLimit, strangerMessageCounts] = await Promise.all([
    options.includeActionLimits
      ? getConnectionRequestLimitState(currentUserId)
      : Promise.resolve(null),
    options.includeActionLimits && uniqueIds.length > 0
      ? prismaRead.messages.groupBy({
          by: ['receiverId'],
          where: {
            senderId: currentUserId,
            receiverId: { in: uniqueIds },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  const sentMessageCountByTarget = new Map(
    strangerMessageCounts.map((row) => [row.receiverId, row._count._all])
  );
  const result = new Map<string, PeopleRelationshipCapability>();
  for (const targetId of uniqueIds) {
    result.set(targetId, {
      connectionStatus: 'none',
      canConnect: connectionLimit?.allowed ?? true,
      canMessage: options.includeActionLimits
        ? (sentMessageCountByTarget.get(targetId) || 0) < 2
        : false,
      canBlock: true,
    });
  }
  if (uniqueIds.length === 0) return result;

  const connections = await prismaRead.connections.findMany({
    where: {
      OR: [
        { requesterId: currentUserId, addresseeId: { in: uniqueIds } },
        { requesterId: { in: uniqueIds }, addresseeId: currentUserId },
      ],
    },
    select: { requesterId: true, addresseeId: true, status: true },
  });

  for (const connection of connections) {
    const targetId = connection.requesterId === currentUserId ? connection.addresseeId : connection.requesterId;
    if (connection.status !== 'accepted' && connection.status !== 'pending') continue;
    const connectionStatus: PeopleConnectionStatus = connection.status === 'accepted'
      ? 'connected'
      : connection.requesterId === currentUserId ? 'pending_sent' : 'pending_received';
    result.set(targetId, {
      connectionStatus,
      canConnect: false,
      canMessage: connectionStatus === 'connected' || (
        options.includeActionLimits && (sentMessageCountByTarget.get(targetId) || 0) < 2
      ),
      canBlock: true,
    });
  }
  return result;
}
