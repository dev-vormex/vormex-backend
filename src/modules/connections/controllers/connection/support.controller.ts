
import { Response } from "express";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";

export type { AuthenticatedRequest as AuthRequest } from "../../../../shared/types/authenticated-request";

export const TOP_NETWORKERS_CACHE_TAG = 'engagement:leaderboard';

export type CanonicalRelationshipStatus = 'none' | 'pending_sent' | 'pending_received' | 'connected';

export const canonicalRelationship = (
  status: CanonicalRelationshipStatus,
  connectionId: string | null
) => ({ status, connectionId });

export const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

export const discoveryCacheTags = (...userIds: Array<string | null | undefined>): string[] =>
  uniqueCacheTags(
    [
      TOP_NETWORKERS_CACHE_TAG,
      ...userIds.flatMap((userId) =>
        userId
          ? [
              `people:user:${userId}`,
              `people:connections:${userId}`,
              `matching:user:${userId}`,
              `user:${userId}`,
            ]
          : []
      ),
    ]
  );

export const invalidateDiscoveryCaches = async (
  ...userIds: Array<string | null | undefined>
): Promise<void> => {
  const tags = discoveryCacheTags(...userIds);
  if (tags.length === 0) return;

  try {
    await cacheService.invalidateTags(...tags);
  } catch (error) {
    console.error('connection discovery cache invalidation failed:', error);
  }
};

export /**
 * Withdraw one outbound request, answering with the pair's settled relationship.
 *
 * Cancelling used to 404 when the row was already gone and 400 when it was no
 * longer pending. Both clients read any non-2xx as "the cancel failed" and roll
 * the button back to Pending, so a connection id that had outlived its row — a
 * cached profile payload, a server-cached discovery list, a second tab that
 * already cancelled — left the viewer with a Pending button that could never be
 * cleared, because every retry answered 404 again.
 *
 * The viewer's intent is "leave no request of mine outstanding", and that intent
 * is already satisfied when the row is missing. So this reports success and
 * describes where the pair actually stands; the client publishes that verdict
 * and converges even when the id it held was stale.
 */
const withdrawSentRequest = async (
  viewerId: string,
  connection: { id: string; requesterId: string; addresseeId: string; status: string } | null,
  res: Response
): Promise<void> => {
  if (!connection) {
    res.status(200).json({
      message: 'Connection request already cancelled',
      relationship: canonicalRelationship('none', null),
    });
    return;
  }

  // A row belonging to neither party is the one genuine authorization failure.
  if (connection.requesterId !== viewerId && connection.addresseeId !== viewerId) {
    res.status(403).json({ error: 'Not authorized to cancel this request' });
    return;
  }

  /*
   * Anything else means the viewer has no outbound request to withdraw — they
   * are already connected, or the request points the other way and is theirs to
   * accept or reject. Their intent is satisfied either way, so report success
   * and say where the pair actually stands. Refusing here is what stranded the
   * button: the client reverts on any error, so a profile that had drifted to a
   * phantom "Pending" could never be talked out of it.
   */
  if (connection.status === 'accepted') {
    res.status(200).json({
      message: 'Already connected',
      relationship: canonicalRelationship('connected', connection.id),
    });
    return;
  }

  if (connection.requesterId !== viewerId) {
    res.status(200).json({
      message: 'Connection request was sent to you',
      relationship: canonicalRelationship(
        connection.status === 'pending' ? 'pending_received' : 'none',
        connection.status === 'pending' ? connection.id : null
      ),
    });
    return;
  }

  if (connection.status !== 'pending') {
    // rejected/blocked rows are not an outstanding request; nothing to withdraw.
    res.status(200).json({
      message: 'Connection request already cancelled',
      relationship: canonicalRelationship('none', null),
    });
    return;
  }

  await prisma.$transaction([
    prisma.notifications.deleteMany({
      where: {
        userId: connection.addresseeId,
        type: 'connection_request',
        actorId: connection.requesterId,
      },
    }),
    prisma.connections.deleteMany({
      // Scoped by requester and status so a concurrent accept cannot be deleted
      // out from under the other side between the read above and this write.
      where: { id: connection.id, requesterId: viewerId, status: 'pending' },
    }),
  ]);

  res.status(200).json({
    message: 'Connection request cancelled',
    relationship: canonicalRelationship('none', null),
  });

  // Evict after responding; see sendConnectionRequest for the reasoning.
  void invalidateDiscoveryCaches(connection.requesterId, connection.addresseeId);
};
