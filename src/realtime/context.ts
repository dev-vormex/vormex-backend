import { Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/prisma';
import { logger } from '../infrastructure/logging/logger';
import { isRedisEnabled, redisCommand } from '../infrastructure/redis/client';
import { ACCESS_TOKEN_COOKIE, parseCookieHeader } from '../modules/auth/utils/auth-cookie.util';
import { evaluateRateLimit } from '../infrastructure/security/rate-limit.service';
import { getConversationPeerIdCached } from '../modules/chat/services/chat-conversation-cache.service';
import { TtlMemo } from '../infrastructure/cache/ttl-memo';
import { buildAuthorizedPresenceRooms, buildCoarseSocketLocation, buildSocketLocationEventPayload, coarseNearbyRoom } from '../modules/proximity/utils/socket-location-events.util';
import { enqueuePendingDeliveryReconciliation, reconcilePendingMessageDeliveries } from '../modules/chat/services/chat-delivery-reconciliation.service';
import { getBlockedUserIds } from '../modules/safety/services/trust-safety.service';

export function createSocketContext(io: SocketIOServer) {
  // Track user socket mappings
  const userSockets = new Map<string, Set<string>>(); // userId -> Set of socketIds
  const socketUsers = new Map<string, string>(); // socketId -> userId
  const socketLocationUpdateTimestamps = new Map<string, number>();
  const chatPresenceRefreshTimers = new Map<string, NodeJS.Timeout>();
  const chatTypingBroadcastTimestamps = new Map<string, number>();
  const CHAT_PRESENCE_TTL_SECONDS = 90;
  const CHAT_TYPING_BROADCAST_INTERVAL_MS = 1_000;

  function chatPresenceKey(userId: string): string {
    return `vormex:chat:presence:${userId}`;
  }

  async function registerSharedChatPresence(userId: string, socketId: string): Promise<boolean | null> {
    if (!isRedisEnabled() || !redisCommand) return null;
    const now = Date.now();
    try {
      const previousCount = await redisCommand.eval(
        `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
       local count = redis.call('ZCARD', KEYS[1])
       redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
       redis.call('EXPIRE', KEYS[1], ARGV[4])
       return count`,
        1,
        chatPresenceKey(userId),
        now,
        now + CHAT_PRESENCE_TTL_SECONDS * 1_000,
        socketId,
        CHAT_PRESENCE_TTL_SECONDS
      );
      return Number(previousCount) === 0;
    } catch (error) {
      logger.warn({
        event: 'chat.presence.register_failed',
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function refreshSharedChatPresence(userId: string, socketId: string): Promise<void> {
    if (!isRedisEnabled() || !redisCommand) return;
    const now = Date.now();
    await redisCommand
      .multi()
      .zadd(chatPresenceKey(userId), now + CHAT_PRESENCE_TTL_SECONDS * 1_000, socketId)
      .expire(chatPresenceKey(userId), CHAT_PRESENCE_TTL_SECONDS)
      .exec();
  }

  function startChatPresenceRefresh(userId: string, socketId: string): void {
    if (!isRedisEnabled() || !redisCommand) return;
    const existing = chatPresenceRefreshTimers.get(socketId);
    if (existing) clearInterval(existing);
    const timer = setInterval(
      () => {
        void refreshSharedChatPresence(userId, socketId).catch((error) => {
          logger.warn({
            event: 'chat.presence.refresh_failed',
            userId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
      (CHAT_PRESENCE_TTL_SECONDS * 1_000) / 3
    );
    timer.unref();
    chatPresenceRefreshTimers.set(socketId, timer);
  }

  async function unregisterSharedChatPresence(userId: string, socketId: string): Promise<boolean | null> {
    const timer = chatPresenceRefreshTimers.get(socketId);
    if (timer) clearInterval(timer);
    chatPresenceRefreshTimers.delete(socketId);
    if (!isRedisEnabled() || !redisCommand) return null;

    try {
      const remainingCount = await redisCommand.eval(
        `redis.call('ZREM', KEYS[1], ARGV[1])
       redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
       local count = redis.call('ZCARD', KEYS[1])
       if count == 0 then redis.call('DEL', KEYS[1]) end
       return count`,
        1,
        chatPresenceKey(userId),
        socketId,
        Date.now()
      );
      return Number(remainingCount) === 0;
    } catch (error) {
      logger.warn({
        event: 'chat.presence.unregister_failed',
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function getSharedChatPresence(userId: string): Promise<boolean | null> {
    if (!isRedisEnabled() || !redisCommand) return null;
    try {
      const count = await redisCommand.eval(
        `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
       return redis.call('ZCARD', KEYS[1])`,
        1,
        chatPresenceKey(userId),
        Date.now()
      );
      return Number(count) > 0;
    } catch {
      return null;
    }
  }

  async function allowChatTypingBroadcast(userId: string, conversationId: string): Promise<boolean> {
    if (isRedisEnabled() && redisCommand) {
      try {
        const result = await redisCommand.set(
          `vormex:chat:typing-rate:${userId}:${conversationId}`,
          '1',
          'PX',
          CHAT_TYPING_BROADCAST_INTERVAL_MS,
          'NX'
        );
        return result === 'OK';
      } catch {
        // Fall through to the bounded per-process limiter.
      }
    }

    const key = `${userId}:${conversationId}`;
    const now = Date.now();
    const previous = chatTypingBroadcastTimestamps.get(key) || 0;
    if (now - previous < CHAT_TYPING_BROADCAST_INTERVAL_MS) return false;
    chatTypingBroadcastTimestamps.set(key, now);
    if (chatTypingBroadcastTimestamps.size > 10_000) {
      for (const [entryKey, timestamp] of chatTypingBroadcastTimestamps) {
        if (now - timestamp > 60_000) chatTypingBroadcastTimestamps.delete(entryKey);
      }
    }
    return true;
  }

  // Group chat online membership. Module-scoped so all sockets on this instance
  // share one view (it was previously declared per-connection, which made every
  // socket see only its own joins). Per-instance only; counts are approximate
  // when running multiple instances.
  const groupOnlineCounts = new Map<string, Set<string>>();

  // Identity payload for group typing broadcasts; avoids a DB read per keystroke.
  const groupTypingUserMemo = new TtlMemo<unknown>(60_000, 5_000);

  async function allowGroupSocketAction(
    socket: any,
    userId: string,
    action: 'join' | 'typing' | 'message' | 'delete_message'
  ): Promise<boolean> {
    const policy = {
      join: { limit: 30, windowSeconds: 60 },
      typing: { limit: 20, windowSeconds: 5 },
      message: { limit: 30, windowSeconds: 10 },
      delete_message: { limit: 10, windowSeconds: 60 },
    }[action];
    try {
      const result = await evaluateRateLimit(userId, {
        keyPrefix: `socket:group:${action}`,
        ...policy,
      });
      if (result.allowed) return true;
      socket.emit('error', {
        message: 'Group action rate limit exceeded',
        code: 'group_socket_rate_limited',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    } catch {
      socket.emit('error', {
        message: 'Group action is temporarily unavailable',
        code: 'group_socket_rate_limiter_unavailable',
      });
    }
    return false;
  }

  // Helper to get userId from socket
  const getSocketUserId = (socket: any): string | null => {
    return socket.data?.userId || socketUsers.get(socket.id) || null;
  };

  async function getAcceptedConnectionIdsForRealtime(userId: string): Promise<string[]> {
    const connections = await prisma.connections.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: {
        requesterId: true,
        addresseeId: true,
      },
      take: 500,
    });

    return Array.from(
      new Set(
        connections.map((connection) =>
          connection.requesterId === userId ? connection.addresseeId : connection.requesterId
        )
      )
    );
  }

  // Rooms of users who must not receive this user's presence/location events
  // (blocked in either direction). Used with `.except()` so the shared coarse
  // nearby room cannot leak presence to a blocked user.
  async function getBlockedRealtimeRooms(userId: string): Promise<string[]> {
    const blockedUserIds = await getBlockedUserIds(userId);
    return blockedUserIds.map((blockedId) => `user:${blockedId}`);
  }

  async function getRealtimeLocationUser(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        shareLocationPublic: true,
        currentCity: true,
        currentState: true,
        currentCountry: true,
      },
    });
  }

  async function getAuthorizedRealtimeRooms(user: {
    id: string;
    shareLocationPublic?: boolean | null;
    currentCity?: string | null;
    currentState?: string | null;
    currentCountry?: string | null;
  }) {
    if (user.shareLocationPublic !== true) {
      return [];
    }

    const [acceptedConnectionIds, blockedUserIds] = await Promise.all([
      getAcceptedConnectionIdsForRealtime(user.id),
      getBlockedUserIds(user.id),
    ]);
    const blockedSet = new Set(blockedUserIds);
    const connectionIds = acceptedConnectionIds.filter((connectionId) => !blockedSet.has(connectionId));
    const location = buildCoarseSocketLocation({}, user);
    return buildAuthorizedPresenceRooms(connectionIds, location);
  }

  async function joinCoarseNearbyRoomIfAllowed(socket: any, userId: string): Promise<void> {
    const user = await getRealtimeLocationUser(userId);
    if (!user || user.shareLocationPublic !== true) {
      return;
    }

    const room = coarseNearbyRoom(buildCoarseSocketLocation({}, user));
    if (room) {
      socket.join(room);
    }
  }

  async function emitPresenceToAuthorizedRooms(
    socket: any,
    userId: string,
    eventName: 'user:online' | 'user:offline'
  ): Promise<void> {
    const user = await getRealtimeLocationUser(userId);
    if (!user) {
      return;
    }

    const location = buildCoarseSocketLocation({}, user);
    const payload = buildSocketLocationEventPayload(user, location);
    if (!payload) {
      return;
    }

    const rooms = await getAuthorizedRealtimeRooms(user);
    const blockedRooms = await getBlockedRealtimeRooms(user.id);
    for (const room of rooms) {
      socket.to(room).except(blockedRooms).emit(eventName, payload);
    }
  }

  function getSocketHandshakeToken(socket: any): string | null {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const token = socket.handshake.auth?.token || cookies[ACCESS_TOKEN_COOKIE];
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  }

  // Helper to emit to user by userId (all their connected sockets)
  const emitToUser = (userId: string, event: string, data: any) => {
    io.to(`user:${userId}`).emit(event, data);
  };

  // Peers who should receive chat presence updates for a user: recent conversation
  // partners plus accepted connections. Independent of location sharing.
  async function getChatPresencePeerIds(userId: string): Promise<string[]> {
    const [conversations, connectionIds, blockedUserIds] = await Promise.all([
      prisma.conversations.findMany({
        where: {
          OR: [{ participant1Id: userId }, { participant2Id: userId }],
        },
        select: { participant1Id: true, participant2Id: true },
        orderBy: { lastMessageAt: 'desc' },
        take: 300,
      }),
      getAcceptedConnectionIdsForRealtime(userId),
      getBlockedUserIds(userId),
    ]);

    const blockedSet = new Set(blockedUserIds);
    const peerIds = new Set<string>(connectionIds.filter((peerId) => !blockedSet.has(peerId)));
    for (const conversation of conversations) {
      const peerId = conversation.participant1Id === userId ? conversation.participant2Id : conversation.participant1Id;
      if (!blockedSet.has(peerId)) peerIds.add(peerId);
    }
    peerIds.delete(userId);
    return Array.from(peerIds);
  }

  async function emitChatPresence(userId: string, isOnline: boolean): Promise<void> {
    const peerIds = await getChatPresencePeerIds(userId);
    if (peerIds.length === 0) return;

    const payload = {
      userId,
      isOnline,
      lastActiveAt: new Date().toISOString(),
    };
    io.to(peerIds.map((peerId) => `user:${peerId}`)).emit(isOnline ? 'user:online' : 'user:offline', payload);
  }

  // Mark every pending message to this user as delivered (WhatsApp-style double tick)
  // and tell each sender. Runs when the recipient's device comes online.
  async function markPendingMessagesDelivered(userId: string): Promise<void> {
    const result = await reconcilePendingMessageDeliveries(userId);
    for (const group of result.groups) {
      emitToUser(group.senderId, 'chat:messages_delivered', {
        conversationId: group.conversationId,
        deliveredTo: userId,
        deliveredAt: result.deliveredAt,
      });
    }
    if (result.hasMore) {
      await enqueuePendingDeliveryReconciliation(userId);
    }
  }

  // User select for chat queries
  const chatUserSelect = {
    id: true,
    username: true,
    name: true,
    profileImage: true,
    isOnline: true,
    lastActiveAt: true,
    isVerified: true,
    profileBadgeStyle: true,
    identityTrustLevel: true,
  };

  const buildGroupMessagePreview = (content: string, contentType: string): string => {
    if (content && content.trim()) {
      return content.trim();
    }

    switch (contentType) {
      case 'image':
        return 'Sent a photo';
      case 'video':
        return 'Sent a video';
      case 'file':
        return 'Sent a file';
      case 'audio':
        return 'Sent a voice message';
      default:
        return 'Sent a message';
    }
  };

  async function isConversationParticipant(conversationId: string, userId: string): Promise<boolean> {
    if (!conversationId || !userId) {
      return false;
    }

    const conversation = await prisma.conversations.findFirst({
      where: {
        id: conversationId,
        OR: [{ participant1Id: userId }, { participant2Id: userId }],
      },
      select: { id: true },
    });

    return Boolean(conversation);
  }

  async function getConversationPeerId(conversationId: string, userId: string): Promise<string | null> {
    // Memoized: participants are immutable per conversation, and this runs on
    // hot socket paths (typing, delivered, mark_read).
    return getConversationPeerIdCached(conversationId, userId);
  }

  return {
    userSockets,
    socketUsers,
    socketLocationUpdateTimestamps,
    registerSharedChatPresence,
    startChatPresenceRefresh,
    unregisterSharedChatPresence,
    getSharedChatPresence,
    allowChatTypingBroadcast,
    groupOnlineCounts,
    groupTypingUserMemo,
    allowGroupSocketAction,
    getSocketUserId,
    getAcceptedConnectionIdsForRealtime,
    getRealtimeLocationUser,
    joinCoarseNearbyRoomIfAllowed,
    emitPresenceToAuthorizedRooms,
    getSocketHandshakeToken,
    emitToUser,
    emitChatPresence,
    markPendingMessagesDelivered,
    chatUserSelect,
    buildGroupMessagePreview,
    isConversationParticipant,
    getConversationPeerId,
  };
}

export type SocketContext = ReturnType<typeof createSocketContext>;
