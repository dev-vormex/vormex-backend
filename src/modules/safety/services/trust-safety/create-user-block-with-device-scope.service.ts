import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { evaluateAccountMayAct, evaluateInteraction, type SafetyDenialReason } from "../safety-policy";
import { db, BLOCKED_USER_IDS_CACHE_TTL_SECONDS, SafetyActionError } from "./safety-action-error.service";
import { invalidateMessageInteractionCache } from "./invalidate-message-interaction-cache.service";
import { getUserInstallHashes } from "./record-user-device-from-request.service";

export async function createUserBlockWithDeviceScope(params: {
  blockerId: string;
  blockedId: string;
  reason?: string | null;
  tx?: PrismaClient | any;
}): Promise<{
  block: any;
  deviceScopeCount: number;
  affectedUserIds: string[];
  affectedConversationIds: string[];
  connectionRemoved: boolean;
  removedConnectionCount: number;
  removedFollowCount: number;
  removedNotificationCount: number;
  removedSavedProfileCount: number;
  removedProfileViewCount: number;
}> {
  const execute = async (client: any) => {
    const block = await client.user_blocks.upsert({
    where: {
      blockerId_blockedId: {
        blockerId: params.blockerId,
        blockedId: params.blockedId,
      },
    },
    create: {
      blockerId: params.blockerId,
      blockedId: params.blockedId,
      reason: params.reason || null,
    },
    update: {
      reason: params.reason === undefined ? undefined : params.reason,
    },
  });

    const blockedDevices = await client.user_devices.findMany({
    where: { userId: params.blockedId },
    select: { installHash: true, platform: true },
    distinct: ['installHash'],
  });
    const uniqueDevices = Array.from(
      new Map(blockedDevices.map((device: any) => [device.installHash, device])).values()
    ).filter((device: any) => Boolean(device.installHash));

    if (uniqueDevices.length > 0) {
      await client.user_block_device_scopes.createMany({
        data: uniqueDevices.map((device: any) => ({
        blockId: block.id,
        blockerId: params.blockerId,
        installHash: device.installHash,
        platform: device.platform || null,
        })),
        skipDuplicates: true,
      });
    }

    const installHashes = uniqueDevices.map((device: any) => device.installHash);
    const linkedUsers = installHashes.length > 0
      ? await client.user_devices.findMany({
          where: { installHash: { in: installHashes } },
          select: { userId: true },
          distinct: ['userId'],
        })
      : [];
    const affectedUserIds = Array.from(new Set([
      params.blockedId,
      ...linkedUsers.map((row: any) => String(row.userId)),
    ])).filter((id) => id && id !== params.blockerId);

    const pairWhere = {
      OR: [
        { requesterId: params.blockerId, addresseeId: { in: affectedUserIds } },
        { requesterId: { in: affectedUserIds }, addresseeId: params.blockerId },
      ],
    };
    const followWhere = {
      OR: [
        { followerId: params.blockerId, followingId: { in: affectedUserIds } },
        { followerId: { in: affectedUserIds }, followingId: params.blockerId },
      ],
    };
    const conversationWhere = {
      OR: [
        { participant1Id: params.blockerId, participant2Id: { in: affectedUserIds } },
        { participant1Id: { in: affectedUserIds }, participant2Id: params.blockerId },
      ],
    };

    const [connectionsToDelete, followsToDelete, conversations] = await Promise.all([
      client.connections.findMany({
        where: pairWhere,
        select: { id: true, requesterId: true, addresseeId: true, status: true },
      }),
      client.follows.findMany({
        where: followWhere,
        select: { id: true, followerId: true, followingId: true },
      }),
      client.conversations.findMany({ where: conversationWhere, select: { id: true } }),
    ]);

    const [
      deletedConnections,
      deletedFollows,
      deletedNotifications,
      deletedSavedProfiles,
      deletedProfileViews,
    ] = await Promise.all([
      connectionsToDelete.length > 0
        ? client.connections.deleteMany({ where: { id: { in: connectionsToDelete.map((row: any) => row.id) } } })
        : Promise.resolve({ count: 0 }),
      followsToDelete.length > 0
        ? client.follows.deleteMany({ where: { id: { in: followsToDelete.map((row: any) => row.id) } } })
        : Promise.resolve({ count: 0 }),
      client.notifications.deleteMany({
        where: {
          OR: [
            { userId: params.blockerId, actorId: { in: affectedUserIds } },
            { userId: { in: affectedUserIds }, actorId: params.blockerId },
          ],
        },
      }),
      client.saved_profiles.deleteMany({
        where: {
          OR: [
            { userId: params.blockerId, targetUserId: { in: affectedUserIds } },
            { userId: { in: affectedUserIds }, targetUserId: params.blockerId },
          ],
        },
      }),
      client.profile_views.deleteMany({
        where: {
          OR: [
            { viewerId: params.blockerId, viewedId: { in: affectedUserIds } },
            { viewerId: { in: affectedUserIds }, viewedId: params.blockerId },
          ],
        },
      }),
    ]);

    // Recompute only the users whose rows were affected. This keeps counters exact,
    // cannot go below zero, and makes repeat block requests safely idempotent.
    const counterUserIds = Array.from(new Set([
      ...connectionsToDelete.flatMap((row: any) => [row.requesterId, row.addresseeId]),
      ...followsToDelete.flatMap((row: any) => [row.followerId, row.followingId]),
    ].filter(Boolean)));
    await Promise.all(counterUserIds.map(async (userId) => {
      const [connectionsCount, followersCount, followingCount] = await Promise.all([
        client.connections.count({
          where: {
            status: 'accepted',
            OR: [{ requesterId: userId }, { addresseeId: userId }],
          },
        }),
        client.follows.count({ where: { followingId: userId } }),
        client.follows.count({ where: { followerId: userId } }),
      ]);
      await client.userStats.updateMany({
        where: { userId },
        data: { connectionsCount, followersCount, followingCount },
      });
    }));

    return {
      block,
      deviceScopeCount: uniqueDevices.length,
      affectedUserIds,
      affectedConversationIds: conversations.map((row: any) => String(row.id)),
      connectionRemoved: connectionsToDelete.length > 0,
      removedConnectionCount: deletedConnections.count,
      removedFollowCount: deletedFollows.count,
      removedNotificationCount: deletedNotifications.count,
      removedSavedProfileCount: deletedSavedProfiles.count,
      removedProfileViewCount: deletedProfileViews.count,
    };
  };

  const result = params.tx
    ? await execute(db(params.tx))
    : await prisma.$transaction((tx) => execute(tx), {
        maxWait: 10_000,
        timeout: 30_000,
      });

  invalidateMessageInteractionCache(params.blockerId, params.blockedId);
  if (!params.tx) {
    await invalidateBlockedUserIdsCache(params.blockerId, ...result.affectedUserIds);
  }

  return result;
}

export async function findBlockBetween(userAId: string, userBId: string) {
  // All three lookups run concurrently: this check sits on the hot path of
  // every message/interaction, and serial round-trips dominate its latency.
  const [explicit, userAInstallHashes, userBInstallHashes] = await Promise.all([
    prisma.user_blocks.findFirst({
      where: {
        OR: [
          { blockerId: userAId, blockedId: userBId },
          { blockerId: userBId, blockedId: userAId },
        ],
      },
    }),
    getUserInstallHashes(userAId),
    getUserInstallHashes(userBId),
  ]);
  if (explicit) return explicit;
  const scopedWhere: any[] = [];
  if (userBInstallHashes.length > 0) {
    scopedWhere.push({
      blockerId: userAId,
      installHash: { in: userBInstallHashes },
    });
  }
  if (userAInstallHashes.length > 0) {
    scopedWhere.push({
      blockerId: userBId,
      installHash: { in: userAInstallHashes },
    });
  }
  if (scopedWhere.length === 0) return null;

  const scoped = await prisma.user_block_device_scopes.findFirst({
    where: { OR: scopedWhere },
    include: { block: true },
  });
  return scoped?.block || null;
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const cacheKey = `safety:blocked-users:v1:user:${userId}`;
  return cacheService.getOrSet(cacheKey, async () => {
    const [rows, ownInstallHashes, outgoingDeviceScopes] = await Promise.all([
      prisma.user_blocks.findMany({
        where: {
          OR: [
            { blockerId: userId },
            { blockedId: userId },
          ],
        },
        select: {
          blockerId: true,
          blockedId: true,
        },
      }),
      getUserInstallHashes(userId),
      prisma.user_block_device_scopes.findMany({
        where: { blockerId: userId },
        select: { installHash: true },
        distinct: ['installHash'],
      }),
    ]);
    const blockedIds = new Set(rows.map((row) => (
      row.blockerId === userId ? row.blockedId : row.blockerId
    )));

    const outgoingHashes = outgoingDeviceScopes.map((row: any) => row.installHash).filter(Boolean);
    if (outgoingHashes.length > 0) {
      const linkedUsers = await prisma.user_devices.findMany({
        where: {
          installHash: { in: outgoingHashes },
          userId: { not: userId },
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      linkedUsers.forEach((row: any) => blockedIds.add(row.userId));
    }

    if (ownInstallHashes.length > 0) {
      const scopedBlocksAgainstThisDevice = await prisma.user_block_device_scopes.findMany({
        where: { installHash: { in: ownInstallHashes } },
        select: { blockerId: true },
        distinct: ['blockerId'],
      });
      scopedBlocksAgainstThisDevice.forEach((row: any) => {
        if (row.blockerId !== userId) blockedIds.add(row.blockerId);
      });
    }

    return Array.from(blockedIds);
  }, {
    ttlSeconds: BLOCKED_USER_IDS_CACHE_TTL_SECONDS,
    tags: [`safety:blocked:${userId}`],
  });
}

export async function invalidateBlockedUserIdsCache(...userIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(userIds.map(String).filter(Boolean)));
  if (uniqueIds.length === 0) return;
  await cacheService.invalidateTags(
    ...uniqueIds.flatMap((userId) => [
      `safety:blocked:${userId}`,
      `feed:${userId}`,
      `stories:${userId}`,
      `reels:${userId}`,
      `reels:feed`,
      `chat:user:${userId}`,
      `profile:${userId}`,
      `people:user:${userId}`,
      `matching:user:${userId}`,
      `notifications:${userId}`,
      `relationships:${userId}`,
      `user:${userId}`,
    ])
  );
}

export async function areUsersBlocked(userAId: string, userBId: string): Promise<boolean> {
  if (!userAId || !userBId || userAId === userBId) return false;
  return Boolean(await findBlockBetween(userAId, userBId));
}

/**
 * Maps a policy denial to the legacy SafetyActionError codes/messages. Kept
 * here (not in safety-policy.ts) because SafetyActionError carries HTTP-ish
 * metadata that the pure policy deliberately does not know about.
 */
export function safetyDenialToError(
  reason: SafetyDenialReason,
  action = 'action'
): SafetyActionError {
  switch (reason) {
    case 'ACCOUNT_BANNED':
      return new SafetyActionError('Your account is banned.', 'account_banned');
    case 'ACCOUNT_SUSPENDED':
      return new SafetyActionError('Your account is temporarily suspended.', 'account_suspended');
    case 'ACCOUNT_RESTRICTED':
      return new SafetyActionError('This action is temporarily restricted.', 'safety_restricted');
    case 'TARGET_UNAVAILABLE':
      return new SafetyActionError('This user is not available right now.', 'target_unavailable', 404);
    case 'BLOCKED':
      return new SafetyActionError(`This ${action} is blocked by your safety settings.`, 'user_blocked');
    default:
      return new SafetyActionError('This resource is unavailable.', 'resource_unavailable', 404, undefined, false);
  }
}

export async function assertUsersCanInteract(
  actorId: string,
  targetUserId: string,
  action: string
): Promise<void> {
  if (!actorId || !targetUserId || actorId === targetUserId) return;

  const [actor, target, block] = await Promise.all([
    prisma.user.findUnique({
      where: { id: actorId },
      select: { isBanned: true, safetyRestrictedUntil: true, safetySuspendedUntil: true },
    }),
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { isBanned: true, safetySuspendedUntil: true },
    }),
    findBlockBetween(actorId, targetUserId),
  ]);

  const decision = evaluateInteraction({ actorId, targetId: targetUserId, actor, target, blocked: Boolean(block) });
  if (!decision.allowed) throw safetyDenialToError(decision.reason!, action);
}

/**
 * Is this account allowed to perform social operations at all (not banned,
 * suspended or restricted)? For entry points that act without a specific
 * target user (posting, commenting on own content, joining).
 */
export async function assertAccountMayAct(userId: string): Promise<void> {
  if (!userId) return;
  const actor = await prisma.user.findUnique({
    where: { id: userId },
    select: { isBanned: true, safetyRestrictedUntil: true, safetySuspendedUntil: true },
  });
  const decision = evaluateAccountMayAct(actor);
  if (!decision.allowed) throw safetyDenialToError(decision.reason!);
}
