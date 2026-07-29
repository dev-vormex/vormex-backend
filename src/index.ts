// @ts-nocheck
import 'dotenv/config';
import { randomUUID } from 'crypto';
import express, { Express, Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { createAdapter } from '@socket.io/redis-adapter';
import { prisma, disconnectPrisma, collectDbConnectionMetrics } from './config/prisma';
import { validateAuthRuntimeConfig } from './config/auth-security.config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { httpLogger, logger } from './lib/logger';
import {
  metricsMiddleware,
  requireMetricsIpAllowList,
} from './middleware/metrics.middleware';
import { requireAdmin } from './middleware/admin.middleware';
import authRoutes from './routes/auth.routes';
import passwordRoutes from './routes/password.routes';
import oauthRoutes from './routes/oauth.routes';
import verificationRoutes from './routes/verification.routes';
import integrationsRoutes from './routes/integrations.routes';
import profileRoutes from './routes/profile.routes';
import professionalFieldsRoutes from './routes/professional-fields.routes';
import uploadRoutes from './routes/upload.routes';
import engagementRoutes from './routes/engagement.routes';
import progressRoutes from './routes/progress.routes';
import storiesRoutes from './routes/stories.routes';
import feedRoutes from './routes/feed.routes';
import postRoutes from './routes/post.routes';
import savedRoutes from './routes/saved.routes';
import mentionsRoutes from './routes/mentions.routes';
import connectionRoutes from './routes/connection.routes';
import followRoutes from './routes/follow.routes';
import chatRoutes from './routes/chat.routes';
import peopleRoutes from './routes/people.routes';
import matchingRoutes from './routes/matching.routes';
import accountabilityRoutes from './routes/accountability.routes';
import skillsRoutes from './routes/skills.routes';
import skillSwapRoutes from './routes/skill-swap.routes';
import groupsRoutes from './routes/groups.routes';
import hackathonsRoutes from './routes/hackathons.routes';
import eventsRoutes from './routes/events.routes';
import collegeCommunitiesRoutes from './routes/college-communities.routes';
import circlesRoutes from './routes/circles.routes';
import onboardingRoutes from './routes/onboarding.routes';
import gamesRoutes from './routes/games.routes';
import locationRoutes from './routes/location.routes';
import proximityRoutes from './routes/proximity.routes';
import socialProofRoutes from './routes/social-proof.routes';
import notificationsRoutes from './routes/notifications.routes';
import reportsRoutes from './routes/reports.routes';
import identityRoutes from './routes/identity.routes';
import safetyRoutes from './routes/safety.routes';
import storeRoutes from './routes/store.routes';
import badgesRoutes from './routes/badges.routes';
import referralsRoutes from './routes/referrals.routes';
import learningRoutes from './routes/learning.routes';
import jobsRoutes from './routes/jobs.routes';
import interviewsRoutes from './routes/interviews.routes';
import challengesRoutes from './routes/challenges.routes';
import aiRoutes from './routes/ai.routes';
import aiChatRoutes from './routes/ai-chat.routes';
import agentRoutes from './routes/agent.routes';
import talkRoutes from './routes/talk.routes';
import devicesRoutes from './routes/devices.routes';
import reelsRoutes from './routes/reels.routes';
import audioRoutes from './routes/audio.routes';
import adminRoutes from './routes/admin.routes';
import managedAdsRoutes from './routes/managed-ads.routes';
import dailyHooksRoutes from './routes/daily-hooks.routes';
import publicDiscoveryRoutes from './routes/public-discovery.routes';
import recommendationRoutes from './routes/recommendation.routes';
import premiumRoutes from './routes/premium.routes';
import { setupSwagger } from './swagger';
import { setIO } from './sockets';
import { register } from './infrastructure/metrics/registry';
import { getAllQueues } from './infrastructure/queue/queues';
import {
  connectRedisClients,
  disconnectRedisClients,
  getRedisHealth,
  isRedisEnabled,
  isRedisRequired,
  redisCommand,
  redisPub,
  redisSub,
} from './infrastructure/redis/client';
import { initializeRealtimeSubscriptions } from './infrastructure/realtime/subscriber';
import { requestSizeGuard } from './infrastructure/security/request-size.middleware';
import { getBackgroundProcessesHealth } from './infrastructure/health/background-process-heartbeat';
import {
  validateAIRequestInput,
  validateRequestInput,
} from './middleware/input-validation.middleware';
import {
  containsPromptInjection,
  sanitizeInputTree,
} from './utils/input-security.util';
import { agentRealtimeVoiceService } from './agent/realtime-voice.service';
import { agentSessionService } from './agent/session.service';
import { botGuard, generalApiRateLimit } from './middleware/abuse-protection.middleware';
import { optionalAppCheck } from './middleware/app-check.middleware';
import { authenticate, optionalAuth, verifySocketAccessToken } from './middleware/auth.middleware';
import { ACCESS_TOKEN_COOKIE, parseCookieHeader } from './utils/auth-cookie.util';
import { getPostMetadata, getReactionSummaries, mapPollOptionsForResponse, normalizeReactionType } from './utils/post.util';
import { canViewPost, canViewReel, canViewStory } from './utils/access-control.util';
import { pushNotificationService } from './services/push-notification.service';
import { getReadReceiptVisibilityCached, sendChatMessage, warmChatSendPath } from './services/chat-message.service';
import { getConversationPeerIdCached } from './services/chat-conversation-cache.service';
import { TtlMemo } from './infrastructure/cache/ttl-memo';
import { emitRealtimeEnvelopes } from './infrastructure/realtime/emitter';
import {
  getAgentAccessDeniedMessage,
  getPremiumAccessSnapshot,
} from './services/premium-access.service';
import { shouldNotifySenderAboutReadReceipt } from './services/chat-read-receipts.service';
import { enqueueCacheInvalidation, enqueueRealtimeFanout } from './outbox/helpers';
import { registerArcadeSocketHandlers } from './sockets/arcade.socket';
import {
  buildAuthorizedPresenceRooms,
  buildCoarseSocketLocation,
  buildSocketLocationEventPayload,
  coarseNearbyRoom,
  shouldThrottleSocketLocationUpdate,
  validateSocketLocationPayload,
} from './utils/socket-location-events.util';
import { installProcessErrorHandlers } from './utils/process-error-handlers.util';
import { connectProximityRedis, closeProximityRedis } from './infrastructure/proximity/redis-client';
import { closeProximityQueues } from './infrastructure/proximity/queues';
import { mcpCorsHeaders, registerPublicDiscoveryMcp } from './mcp/public-discovery.mcp';
import {
  enqueuePendingDeliveryReconciliation,
  reconcilePendingMessageDeliveries,
} from './services/chat-delivery-reconciliation.service';

// Validate required environment variables
const requiredEnvVars = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'FRONTEND_URL',
  'ENCRYPTION_KEY',
];

if (process.env.NODE_ENV === 'production') {
  requiredEnvVars.push('DATABASE_URL', 'JWT_SECRET', 'AUTH_CSRF_SECRET');
}

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

validateAuthRuntimeConfig();

const app: Express = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) {
    return process.env.NODE_ENV === 'production' ? 1 : true;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : value;
}

app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Middleware — add comma-separated origins via CORS_EXTRA_ORIGINS (e.g. admin on Vercel)
const defaultAllowedOrigins = [
  'http://localhost:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
  'https://vormex.in',
  'https://www.vormex.in',
];
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...extraOrigins]);

function isAllowedLocalNetworkOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  return /^https?:\/\/(172\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):(3000|3001)$/.test(origin);
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}

function isAllowedRequestOrigin(origin: string | undefined): boolean {
  if (!origin) {
    // Native/mobile clients and same-origin non-browser tools may omit Origin.
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  return allowedOrigins.has(normalizedOrigin) || isAllowedLocalNetworkOrigin(normalizedOrigin);
}

// Socket.IO Setup - browsers are origin-restricted; native/mobile clients may omit Origin.
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      callback(null, isAllowedRequestOrigin(origin));
    },
    credentials: true,
    methods: ['GET', 'POST'],
  },
  // Prefer WebSocket for low latency, while retaining Engine.IO polling for
  // networks/proxies that cannot complete a WebSocket upgrade.
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  maxHttpBufferSize: 256 * 1024,
});

// Share Socket.IO instance with controllers via the sockets module
setIO(io);

function shouldStartApiRedis(): boolean {
  const mode = (process.env.API_REDIS_MODE || 'auto').toLowerCase();
  if (['1', 'true', 'yes', 'enabled'].includes(mode)) {
    return true;
  }

  if (['0', 'false', 'no', 'disabled'].includes(mode)) {
    return false;
  }

  const redisUrl = process.env.CRITICAL_REDIS_URL || process.env.REDIS_URL || '';
  return process.env.NODE_ENV === 'production' || !/upstash\.io/i.test(redisUrl);
}

const redisStartupPromise = shouldStartApiRedis()
  ? connectRedisClients().then(async () => {
      if (isRedisEnabled() && redisPub && redisSub) {
        io.adapter(createAdapter(redisPub, redisSub));
        await initializeRealtimeSubscriptions(io);
      }
    })
  : Promise.resolve().then(() => {
      logger.warn({
        event: 'redis.api.skipped',
        reason: 'remote_upstash_in_development',
        message: 'API Redis realtime infrastructure skipped. Set API_REDIS_MODE=true to enable it.',
      });
    });

// Import activity service for engagement tracking
import { recordActivity } from './services/activity.service';
import { updateEngagementStreak } from './controllers/engagement.controller';
import { safetyErrorResponse } from './services/trust-safety.service';

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
    logger.warn({ event: 'chat.presence.register_failed', userId, message: error instanceof Error ? error.message : String(error) });
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
  const timer = setInterval(() => {
    void refreshSharedChatPresence(userId, socketId).catch((error) => {
      logger.warn({ event: 'chat.presence.refresh_failed', userId, message: error instanceof Error ? error.message : String(error) });
    });
  }, (CHAT_PRESENCE_TTL_SECONDS * 1_000) / 3);
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
    logger.warn({ event: 'chat.presence.unregister_failed', userId, message: error instanceof Error ? error.message : String(error) });
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

// Helper to get userId from socket
const getSocketUserId = (socket: any): string | null => {
  return socket.data?.userId || socketUsers.get(socket.id) || null;
};

async function getAcceptedConnectionIdsForRealtime(userId: string): Promise<string[]> {
  const connections = await prisma.connections.findMany({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: userId },
        { addresseeId: userId },
      ],
    },
    select: {
      requesterId: true,
      addresseeId: true,
    },
    take: 500,
  });

  return Array.from(new Set(
    connections.map((connection) =>
      connection.requesterId === userId ? connection.addresseeId : connection.requesterId
    )
  ));
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

  const connectionIds = await getAcceptedConnectionIdsForRealtime(user.id);
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
  for (const room of rooms) {
    socket.to(room).emit(eventName, payload);
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
  const [conversations, connectionIds] = await Promise.all([
    prisma.conversations.findMany({
      where: {
        OR: [
          { participant1Id: userId },
          { participant2Id: userId },
        ],
      },
      select: { participant1Id: true, participant2Id: true },
      orderBy: { lastMessageAt: 'desc' },
      take: 300,
    }),
    getAcceptedConnectionIdsForRealtime(userId),
  ]);

  const peerIds = new Set<string>(connectionIds);
  for (const conversation of conversations) {
    peerIds.add(
      conversation.participant1Id === userId
        ? conversation.participant2Id
        : conversation.participant1Id
    );
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
  io.to(peerIds.map((peerId) => `user:${peerId}`)).emit(
    isOnline ? 'user:online' : 'user:offline',
    payload
  );
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
      OR: [
        { participant1Id: userId },
        { participant2Id: userId },
      ],
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

const feedRealtimeRoom = 'feed:global';
const postCommentAuthorSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  headline: true,
};
const reelCommentAuthorSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
};

async function togglePostReactionWithFanout(
  postId: string,
  userId: string,
  reactionType: string | null,
  eventName: 'post:liked' | 'post:reacted'
): Promise<{ liked: boolean; likesCount: number; reactionType: string | null } | null> {
  const requestedReaction = normalizeReactionType(reactionType);
  return prisma.$transaction(async (tx) => {
    const post = await tx.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });

    if (!post || !(await canViewPost(post, userId, tx as any))) {
      return null;
    }

    const existingLike = await tx.postLike.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    // Semantics: no reaction → add; same reaction → remove; different → switch.
    let liked: boolean;
    let nextReaction: string | null;
    if (!existingLike) {
      await tx.postLike.create({
        data: { postId, userId, reactionType: requestedReaction },
      });
      liked = true;
      nextReaction = requestedReaction;
    } else if (existingLike.reactionType === requestedReaction) {
      await tx.postLike.delete({
        where: { postId_userId: { postId, userId } },
      });
      liked = false;
      nextReaction = null;
    } else {
      await tx.postLike.update({
        where: { postId_userId: { postId, userId } },
        data: { reactionType: requestedReaction },
      });
      liked = true;
      nextReaction = requestedReaction;
    }

    const likesCount = await tx.postLike.count({ where: { postId } });
    await tx.post.update({
      where: { id: postId },
      data: { likesCount },
    });
    const summaries = await getReactionSummaries(tx as any, [postId]);
    const reactionSummary = summaries.get(postId) ?? [];
    const postRooms = String(post.visibility || '').toLowerCase() === 'public'
      ? [feedRealtimeRoom, `post:${postId}`]
      : [`post:${postId}`];

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: `post.${eventName}.fanout`,
      envelopes: [
        {
          event: eventName,
          rooms: postRooms,
          payload: {
            postId,
            userId,
            liked,
            reactionType: nextReaction,
            likesCount,
            reactionSummary,
          },
        },
      ],
    });

    await enqueueCacheInvalidation(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: 'post.engagement.cache.invalidate',
      tags: ['feed:global', `feed:${post.authorId}`, `user:${post.authorId}`],
    });

    return {
      liked,
      likesCount,
      reactionType: nextReaction,
    };
  }, {
    maxWait: 10_000,
    timeout: 10_000,
  });
}

async function createPostCommentWithFanout(
  postId: string,
  userId: string,
  content: string,
  parentId?: string,
  mentions?: string[]
): Promise<{ mappedComment: Record<string, unknown>; commentsCount: number } | null> {
  const author = await prisma.user.findUnique({
    where: { id: userId },
    select: postCommentAuthorSelect,
  });

  return prisma.$transaction(async (tx) => {
    const post = await tx.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true },
    });

    if (!post || !(await canViewPost(post, userId, tx as any))) {
      return null;
    }
    if (parentId) {
      const parentComment = await tx.post_comments.findFirst({
        where: { id: parentId, postId },
        select: { id: true },
      });
      if (!parentComment) {
        throw new Error('POST_COMMENT_PARENT_NOT_FOUND');
      }
    }

    const comment = await tx.post_comments.create({
      data: {
        postId,
        authorId: userId,
        parentId: parentId || null,
        content: content.trim(),
      },
    });

    const commentsCount = await tx.post_comments.count({
      where: { postId, parentId: null },
    });

    await tx.post.update({
      where: { id: postId },
      data: { commentsCount },
    });

    const mappedComment = {
      id: comment.id,
      postId: comment.postId,
      parentId: comment.parentId,
      authorId: comment.authorId,
      author: author || {
        id: userId,
        username: 'unknown',
        name: 'Unknown User',
        profileImage: null,
        headline: null,
      },
      content: comment.content,
      contentType: 'text/plain',
      mentions: mentions || [],
      likesCount: comment.likesCount,
      replyCount: 0,
      isLiked: false,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
    const postRooms = String(post.visibility || '').toLowerCase() === 'public'
      ? [feedRealtimeRoom, `post:${postId}`]
      : [`post:${postId}`];

    const envelopes: Array<Record<string, unknown>> = [
      {
        event: 'comment:created',
        rooms: postRooms,
        payload: {
          postId,
          comment: mappedComment,
          commentsCount,
        },
      },
    ];

    if (post.authorId !== userId) {
      envelopes.push({
        event: 'notification:comment',
        users: [post.authorId],
        payload: {
          postId,
          comment: mappedComment,
          commentsCount,
        },
      });
    }

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'post_comment',
      aggregateId: comment.id,
      eventType: 'post.comment.created.fanout',
      envelopes: envelopes as any,
    });

    await enqueueCacheInvalidation(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: 'post.comment.cache.invalidate',
      tags: ['feed:global', `feed:${post.authorId}`, `user:${post.authorId}`],
    });

    return { mappedComment, commentsCount };
  }, {
    maxWait: 10_000,
    timeout: 10_000,
  });
}

async function toggleCommentLikeWithFanout(
  postId: string,
  commentId: string,
  userId: string
): Promise<{ liked: boolean; likesCount: number } | null> {
  return prisma.$transaction(async (tx) => {
    const comment = await tx.post_comments.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        postId: true,
        posts: { select: { authorId: true, visibility: true, isActive: true } },
      },
    });

    if (!comment || comment.postId !== postId || !(await canViewPost(comment.posts, userId, tx as any))) {
      return null;
    }

    const existing = await tx.comment_likes.findUnique({
      where: { commentId_userId: { commentId, userId } },
    });

    let liked = false;
    if (existing) {
      await tx.comment_likes.delete({
        where: { commentId_userId: { commentId, userId } },
      });
    } else {
      await tx.comment_likes.create({
        data: { commentId, userId },
      });
      liked = true;
    }

    const likesCount = await tx.comment_likes.count({ where: { commentId } });
    await tx.post_comments.update({
      where: { id: commentId },
      data: { likesCount },
    });

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'post_comment',
      aggregateId: commentId,
      eventType: 'post.comment.like.fanout',
      envelopes: [
        {
          event: 'comment:liked',
          rooms: [`post:${postId}`],
          payload: {
            commentId,
            postId,
            userId,
            liked,
            likesCount,
          },
        },
      ],
    });

    return { liked, likesCount };
  }, {
    maxWait: 10_000,
    timeout: 10_000,
  });
}

async function votePollWithFanout(
  postId: string,
  optionId: string,
  userId: string
): Promise<Array<Record<string, unknown>> | null> {
  return prisma.$transaction(async (tx) => {
    const post = await tx.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true, visibility: true, isActive: true, metadata: true },
    });

    if (!post || !(await canViewPost(post, userId, tx as any))) {
      return null;
    }

    const metadata = getPostMetadata(post.metadata);
    const pollOptions = metadata.pollOptions || [];
    if (pollOptions.length === 0) {
      throw new Error('POLL_NOT_FOUND');
    }
    if (metadata.pollEndsAt && new Date(metadata.pollEndsAt) < new Date()) {
      throw new Error('POLL_ENDED');
    }
    if (!pollOptions.find((option) => option.id === optionId)) {
      throw new Error('POLL_OPTION_NOT_FOUND');
    }

    const existingVote = await tx.postPollVote.findUnique({
      where: { postId_userId: { postId, userId } },
    });
    if (existingVote) {
      throw new Error('POLL_ALREADY_VOTED');
    }

    await tx.postPollVote.create({
      data: { postId, userId, optionId },
    });

    const updatedOptions = pollOptions.map((option) =>
      option.id === optionId
        ? { ...option, votes: Math.max(0, Number(option.votes || 0)) + 1 }
        : { ...option, votes: Math.max(0, Number(option.votes || 0)) }
    );

    await tx.post.update({
      where: { id: postId },
      data: {
        metadata: {
          ...(post.metadata || {}),
          pollOptions: updatedOptions,
        },
      },
    });

    const responseOptions = mapPollOptionsForResponse(updatedOptions, optionId);
    const postRooms = String(post.visibility || '').toLowerCase() === 'public'
      ? [feedRealtimeRoom, `post:${postId}`]
      : [`post:${postId}`];

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: 'post.poll.vote.fanout',
      envelopes: [
        {
          event: 'poll:updated',
          rooms: postRooms,
          payload: {
            postId,
            voterId: userId,
            votedOptionId: optionId,
            pollOptions: responseOptions,
          },
        },
      ],
    });

    await enqueueCacheInvalidation(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: 'post.poll.cache.invalidate',
      tags: ['feed:global', `feed:${post.authorId}`, `user:${post.authorId}`],
    });

    return responseOptions as any;
  }, {
    maxWait: 10_000,
    timeout: 10_000,
  });
}

async function toggleReelLikeWithFanout(
  reelId: string,
  userId: string
): Promise<{ liked: boolean; likesCount: number } | null> {
  return prisma.$transaction(async (tx) => {
    const reel = await tx.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true },
    });

    if (!reel || !(await canViewReel(reel, userId, {}, tx as any))) {
      return null;
    }

    const existingLike = await tx.reel_likes.findUnique({
      where: { reelId_userId: { reelId, userId } },
    });

    let liked = false;
    if (existingLike) {
      await tx.reel_likes.delete({
        where: { reelId_userId: { reelId, userId } },
      });
    } else {
      await tx.reel_likes.create({
        data: { reelId, userId },
      });
      liked = true;
    }

    const likesCount = await tx.reel_likes.count({ where: { reelId } });
    await tx.reels.update({
      where: { id: reelId },
      data: { likesCount },
    });

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'reel',
      aggregateId: reelId,
      eventType: 'reel.like.fanout',
      envelopes: [
        {
          event: 'reel:engagement_update',
          rooms: [`reel:${reelId}`],
          payload: {
            reelId,
            type: 'like',
            userId,
            liked,
            likesCount,
          },
        },
      ],
    });

    await enqueueCacheInvalidation(tx as any, {
      aggregateType: 'reel',
      aggregateId: reelId,
      eventType: 'reel.like.cache.invalidate',
      tags: [`feed:${reel.authorId}`, `user:${reel.authorId}`],
    });

    return { liked, likesCount };
  }, {
    maxWait: 10_000,
    timeout: 10_000,
  });
}

async function createReelCommentWithFanout(
  reelId: string,
  userId: string,
  content: string,
  parentId?: string
): Promise<{ commentPayload: Record<string, unknown>; commentsCount: number } | null> {
  const author = await prisma.user.findUnique({
    where: { id: userId },
    select: reelCommentAuthorSelect,
  });

  return prisma.$transaction(async (tx) => {
    const reel = await tx.reels.findUnique({
      where: { id: reelId },
      select: { id: true, authorId: true, visibility: true, status: true, publishedAt: true, allowComments: true },
    });

    if (!reel || !(await canViewReel(reel, userId, {}, tx as any))) {
      return null;
    }
    if (!reel.allowComments) {
      throw new Error('REEL_COMMENTS_DISABLED');
    }
    if (parentId) {
      const parentComment = await tx.reel_comments.findFirst({
        where: { id: parentId, reelId },
        select: { id: true },
      });
      if (!parentComment) {
        throw new Error('REEL_COMMENT_PARENT_NOT_FOUND');
      }
    }

    const comment = await tx.reel_comments.create({
      data: {
        reelId,
        authorId: userId,
        content: content.trim(),
        parentId: parentId || null,
      },
    });

    const commentsCount = await tx.reel_comments.count({
      where: { reelId, parentId: null },
    });
    await tx.reels.update({
      where: { id: reelId },
      data: { commentsCount },
    });

    const commentPayload = {
      id: comment.id,
      reelId: comment.reelId,
      author: author || {
        id: userId,
        username: 'unknown',
        name: 'Unknown User',
        profileImage: null,
      },
      content: comment.content,
      parentId: comment.parentId,
      createdAt: comment.createdAt,
    };

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'reel_comment',
      aggregateId: comment.id,
      eventType: 'reel.comment.fanout',
      envelopes: [
        {
          event: 'reel:engagement_update',
          rooms: [`reel:${reelId}`],
          payload: {
            reelId,
            type: 'comment',
            userId,
            commentsCount,
            comment: commentPayload,
          },
        },
      ],
    });

    await enqueueCacheInvalidation(tx as any, {
      aggregateType: 'reel',
      aggregateId: reelId,
      eventType: 'reel.comment.cache.invalidate',
      tags: [`feed:${reel.authorId}`, `user:${reel.authorId}`],
    });

    return { commentPayload, commentsCount };
  }, {
    maxWait: 10_000,
    timeout: 10_000,
  });
}

io.use(async (socket, next) => {
  const token = getSocketHandshakeToken(socket);
  if (!token) {
    const socketError = new Error('Socket authentication required');
    (socketError as any).data = { code: 'unauthorized' };
    next(socketError);
    return;
  }

  try {
    const decoded = await verifySocketAccessToken(token);
    socket.data.userId = String(decoded.userId);
    socket.data.sessionId = decoded.sessionId;
    next();
  } catch (error) {
    const authError = error instanceof Error ? error.message : 'Socket authentication failed';
    const socketError = new Error(authError);
    (socketError as any).data = {
      code: authError === 'Session is no longer active' ? 'session_inactive' : 'unauthorized',
    };
    next(socketError);
  }
});

// Socket.IO connection handling
io.on('connection', async (socket) => {
  const initialTransport = socket.conn.transport.name;
  logger.info({
    event: 'socket.connected',
    socketId: socket.id,
    transport: initialTransport,
  });
  socket.conn.on('upgrade', (transport) => {
    logger.info({
      event: 'socket.transport.upgrade',
      socketId: socket.id,
      transport: transport.name,
    });
  });

  socket.use((packet, next) => {
    const [eventName, payload] = packet;
    const event = String(eventName || '');

    if (event === 'agent:voice_audio_chunk') {
      const audioBase64 = typeof payload?.audioBase64 === 'string' ? payload.audioBase64 : '';
      if (!audioBase64 || audioBase64.length > 256 * 1024 || !/^[a-zA-Z0-9+/=]+$/.test(audioBase64)) {
        socket.emit('error', { message: 'Invalid voice audio chunk' });
        next(new Error('Invalid voice audio chunk'));
        return;
      }
      next();
      return;
    }

    if (payload !== undefined) {
      const result = sanitizeInputTree(payload, {
        location: 'body',
        maxDepth: 6,
        maxStringLength: 4_000,
      });
      if (!result.ok) {
        socket.emit('error', { message: result.error || 'Invalid socket payload' });
        next(new Error(result.error || 'Invalid socket payload'));
        return;
      }

      if (
        (event.startsWith('agent:') || event.includes('message') || event.includes('comment'))
        && typeof result.value === 'object'
        && result.value !== null
        && JSON.stringify(result.value).length <= 10_000
        && containsPromptInjection(JSON.stringify(result.value))
      ) {
        socket.emit('error', { message: 'Unsafe prompt-injection instructions are not allowed' });
        next(new Error('Unsafe prompt-injection instructions are not allowed'));
        return;
      }

      packet[1] = result.value;
    }

    next();
  });

  // Handle authenticated sockets. Invalid tokens are rejected in io.use above.
  const userId = socket.data?.userId ? String(socket.data.userId) : null;
  if (userId) {
    socketUsers.set(socket.id, userId);
    const wasLocallyOffline = !userSockets.has(userId) || userSockets.get(userId)!.size === 0;
    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(socket.id);
    const sharedWasOffline = await registerSharedChatPresence(userId, socket.id);
    const wasOffline = sharedWasOffline ?? wasLocallyOffline;
    startChatPresenceRefresh(userId, socket.id);

    // Join user's personal room for notifications
      socket.join(`user:${userId}`);
      joinCoarseNearbyRoomIfAllowed(socket, userId).catch((error) => {
        console.error('Failed to join coarse nearby socket room:', error);
      });
      socket.emit('socket:authenticated', { userId });
      logger.info({
        event: 'socket.authenticated',
        socketId: socket.id,
        userId,
        transport: socket.conn.transport.name,
        rooms: Array.from(socket.rooms),
      });

    if (wasOffline) {
      prisma.user.update({
        where: { id: userId },
        data: { isOnline: true, lastActiveAt: new Date() },
      }).catch((error) => {
        console.error('Failed to mark socket user online:', error);
      });
      emitPresenceToAuthorizedRooms(socket, userId, 'user:online').catch((error) => {
        console.error('Failed to emit scoped online presence:', error);
      });
      emitChatPresence(userId, true).catch((error) => {
        console.error('Failed to emit chat presence online:', error);
      });
    }

    markPendingMessagesDelivered(userId).catch((error) => {
      console.error('Failed to mark pending messages delivered:', error);
    });

    console.log(`✅ Socket ${socket.id} authenticated as user ${userId}`);
  }

  registerArcadeSocketHandlers({ io, socket, getSocketUserId });

  socket.on('agent:join_session', async (payload: any = {}) => {
    const authenticatedUserId = getSocketUserId(socket);
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!authenticatedUserId || !sessionId || sessionId.length > 128) {
      return;
    }

    try {
      await agentSessionService.requireSession(sessionId, authenticatedUserId);
      await socket.join(`agent:session:${sessionId}`);
    } catch {
      socket.emit('agent:session_error', {
        sessionId,
        error: 'Agent session not found',
      });
    }
  });

  socket.on('agent:leave_session', ({ sessionId }) => {
    if (!sessionId) {
      return;
    }
    socket.leave(`agent:session:${sessionId}`);
  });

  socket.on('agent:voice_start', async (payload: any = {}) => {
    const authenticatedUserId = getSocketUserId(socket);
    if (!authenticatedUserId) {
      socket.emit('agent:voice_error', {
        error: 'You need to be signed in to use realtime voice.',
      });
      return;
    }

    try {
      const sessionId = String(payload?.sessionId || '').trim();
      if (!sessionId) {
        socket.emit('agent:voice_error', {
          error: 'An agent session is required before starting realtime voice.',
        });
        return;
      }

      const snapshot = await getPremiumAccessSnapshot(authenticatedUserId);
      if (!snapshot.canUseAgent) {
        socket.emit('agent:voice_error', {
          sessionId,
          error: getAgentAccessDeniedMessage(snapshot),
        });
        return;
      }

      await agentRealtimeVoiceService.startSession({
        socketId: socket.id,
        userId: authenticatedUserId,
        sessionId,
        surface: typeof payload?.surface === 'string' ? payload.surface : undefined,
        surfaceContext:
          payload?.surfaceContext && typeof payload.surfaceContext === 'object'
            ? payload.surfaceContext
            : {},
        allowAutonomousActions:
          typeof payload?.allowAutonomousActions === 'boolean'
            ? payload.allowAutonomousActions
            : undefined,
        autonomyMode: typeof payload?.autonomyMode === 'string' ? payload.autonomyMode : undefined,
      });
    } catch (error) {
      socket.emit('agent:voice_error', {
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        error:
          typeof error?.userMessage === 'string'
            ? error.userMessage
            : error instanceof Error
              ? error.message
              : 'Realtime voice is temporarily unavailable right now.',
      });
    }
  });

  socket.on('agent:voice_audio_chunk', (payload: any = {}) => {
    if (typeof payload?.audioBase64 !== 'string' || !payload.audioBase64) {
      return;
    }
    agentRealtimeVoiceService.appendAudioChunk(socket.id, payload.audioBase64);
  });

  socket.on('agent:surface_update', async (payload: any = {}) => {
    try {
      await agentRealtimeVoiceService.updateSurface({
        socketId: socket.id,
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        surface: typeof payload?.surface === 'string' ? payload.surface : undefined,
        surfaceContext:
          payload?.surfaceContext && typeof payload.surfaceContext === 'object'
            ? payload.surfaceContext
            : {},
        allowAutonomousActions:
          typeof payload?.allowAutonomousActions === 'boolean'
            ? payload.allowAutonomousActions
            : undefined,
        autonomyMode: typeof payload?.autonomyMode === 'string' ? payload.autonomyMode : undefined,
      });
    } catch (error) {
      socket.emit('agent:voice_error', {
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        error:
          error instanceof Error
            ? error.message
            : 'Could not sync the current agent surface.',
      });
    }
  });

  socket.on('agent:voice_interrupt', () => {
    agentRealtimeVoiceService.interrupt(socket.id);
  });

  socket.on('agent:voice_prompt', (payload: any = {}) => {
    const instructions =
      typeof payload?.instructions === 'string'
        ? payload.instructions
        : typeof payload?.text === 'string'
          ? payload.text
          : '';
    agentRealtimeVoiceService.prompt(socket.id, instructions);
  });

  socket.on('agent:voice_stop', () => {
    agentRealtimeVoiceService.stopSession(socket.id);
  });

  // Post room events
  socket.on('post:join', async ({ postId }) => {
    const viewerId = getSocketUserId(socket);
    if (!postId) return;

    try {
      const post = await prisma.post.findFirst({
        where: { id: postId, isActive: true },
        select: { authorId: true, visibility: true, isActive: true },
      });
      if (!post || !(await canViewPost(post, viewerId))) {
        socket.emit('error', { message: 'Post not found' });
        return;
      }
      socket.join(`post:${postId}`);
    } catch (error) {
      console.error('post:join error:', error);
      socket.emit('error', { message: 'Failed to join post' });
    }
  });

  socket.on('post:leave', ({ postId }) => {
    socket.leave(`post:${postId}`);
  });

  socket.on('feed:join', () => {
    socket.join(feedRealtimeRoom);
  });

  socket.on('feed:leave', () => {
    socket.leave(feedRealtimeRoom);
  });

  // Post like/react via WebSocket
  socket.on('post:react', async ({ postId, reactionType }) => {
    const reactorUserId = getSocketUserId(socket);
    if (!reactorUserId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const result = await togglePostReactionWithFanout(postId, reactorUserId, reactionType || 'LIKE', 'post:reacted');
      if (!result) {
        socket.emit('error', { message: 'Post not found' });
        return;
      }
      console.log(`Post ${postId} ${result.liked ? 'liked' : 'unliked'} by user ${reactorUserId}`);
    } catch (error) {
      console.error('post:react error:', error);
      socket.emit('error', { message: 'Failed to react to post' });
    }
  });

  // Legacy post:like handler
  socket.on('post:like', async ({ postId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const result = await togglePostReactionWithFanout(postId, userId, 'LIKE', 'post:liked');
      if (!result) {
        socket.emit('error', { message: 'Post not found' });
        return;
      }
      console.log(`Post ${postId} ${result.liked ? 'liked' : 'unliked'} by user ${userId}`);
    } catch (error) {
      console.error('post:like error:', error);
      socket.emit('error', { message: 'Failed to like post' });
    }
  });

  // Post comment via WebSocket
  socket.on('post:comment', async ({ postId, content, parentId, mentions }) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      if (!content || typeof content !== 'string') {
        socket.emit('error', { message: 'Content is required' });
        return;
      }

      const result = await createPostCommentWithFanout(postId, userId, content, parentId, mentions);
      if (!result) {
        socket.emit('error', { message: 'Post not found' });
        return;
      }
      console.log(`Comment created on post ${postId} by user ${userId}`);
    } catch (error) {
      console.error('post:comment error:', error);
      if (error instanceof Error && error.message === 'POST_COMMENT_PARENT_NOT_FOUND') {
        socket.emit('error', { message: 'Parent comment not found' });
        return;
      }
      socket.emit('error', { message: 'Failed to create comment' });
    }
  });

  // Comment like via WebSocket
  socket.on('comment:like', async ({ commentId, postId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const result = await toggleCommentLikeWithFanout(postId, commentId, userId);
      if (!result) {
        socket.emit('error', { message: 'Comment not found' });
        return;
      }

      console.log(`Comment ${commentId} ${result.liked ? 'liked' : 'unliked'} by user ${userId}`);
    } catch (error) {
      console.error('comment:like error:', error);
      socket.emit('error', { message: 'Failed to like comment' });
    }
  });

  // Poll vote via WebSocket
  socket.on('poll:vote', async ({ postId, optionId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const pollOptions = await votePollWithFanout(postId, optionId, userId);
      if (!pollOptions) {
        socket.emit('error', { message: 'Post not found' });
        return;
      }

      console.log(`Poll vote on post ${postId} by user ${userId}`);
    } catch (error) {
      console.error('poll:vote error:', error);
      const message = error instanceof Error ? error.message : '';
      if (message === 'POLL_NOT_FOUND') {
        socket.emit('error', { message: 'This post is not a poll' });
        return;
      }
      if (message === 'POLL_ENDED') {
        socket.emit('error', { message: 'This poll has ended' });
        return;
      }
      if (message === 'POLL_OPTION_NOT_FOUND') {
        socket.emit('error', { message: 'Poll option not found' });
        return;
      }
      if (message === 'POLL_ALREADY_VOTED') {
        socket.emit('error', { message: 'You have already voted on this poll' });
        return;
      }
      socket.emit('error', { message: 'Failed to vote on poll' });
    }
  });

  // ============================================
  // CHAT SOCKET EVENTS
  // ============================================

  // Join chat room (handle both { conversationId } and data?.conversationId for mobile clients)
  socket.on('chat:join', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    const conversationId = data?.conversationId ?? data;
    if (conversationId && typeof conversationId === 'string') {
      try {
        const allowed = await isConversationParticipant(conversationId, userId);
        if (!allowed) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        socket.join(`chat:${conversationId}`);
        logger.info({
          event: 'chat.room.joined',
          socketId: socket.id,
          userId,
          conversationId,
          transport: socket.conn.transport.name,
          rooms: Array.from(socket.rooms),
        });
        void warmChatSendPath(conversationId, userId).catch(() => undefined);
      } catch (error) {
        console.error('chat:join error:', error);
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    } else {
      console.warn('chat:join received invalid data:', JSON.stringify(data));
    }
  });

  // Leave chat room
  socket.on('chat:leave', (data) => {
    const conversationId = data?.conversationId ?? data;
    if (conversationId && typeof conversationId === 'string') {
      socket.leave(`chat:${conversationId}`);
      logger.info({
        event: 'chat.room.left',
        socketId: socket.id,
        userId: getSocketUserId(socket) || undefined,
        conversationId,
        rooms: Array.from(socket.rooms),
      });
    }
  });

  // Send chat message
  socket.on('chat:send_message', async (data, ack) => {
    const acknowledge = typeof ack === 'function' ? ack : undefined;
    const failSend = (message: string) => {
      socket.emit('error', { message });
      acknowledge?.({ ok: false, error: message });
    };
    const senderId = getSocketUserId(socket);
    if (!senderId) {
      failSend('Not authenticated');
      return;
    }

    try {
      const payload = data && typeof data === 'object' ? data : {};
      const {
        conversationId,
        content,
        contentType,
        mediaUrl,
        mediaType,
        fileName,
        fileSize,
        replyToId,
        clientMessageId,
      } = payload as {
        conversationId?: unknown;
        content?: unknown;
        contentType?: unknown;
        mediaUrl?: unknown;
        mediaType?: unknown;
        fileName?: unknown;
        fileSize?: unknown;
        replyToId?: unknown;
        clientMessageId?: unknown;
      };
      if (!conversationId || (!content && !mediaUrl)) {
        failSend('Content or media is required');
        return;
      }

      const result = await sendChatMessage({
        senderId,
        conversationId: String(conversationId),
        content,
        contentType,
        mediaUrl,
        mediaType,
        fileName,
        fileSize,
        replyToId,
        clientMessageId,
      });

      if (!result.wasDuplicate) {
        logger.info({
          event: 'chat.message.persisted.emit_start',
          socketId: socket.id,
          senderId,
          receiverId: result.receiverId,
          conversationId: result.conversationId,
          messageId: result.message.id,
          clientMessageId: result.message.clientMessageId,
          transport: socket.conn.transport.name,
        });
        emitRealtimeEnvelopes(result.realtimeEnvelopes);
      }
      acknowledge?.({ ok: true, message: result.message });

      // Record messaging activity and update streak (non-blocking)
      recordActivity(senderId, 'message', 1, { sourceId: result.message.id }).catch(console.error);
      updateEngagementStreak(senderId, 'messaging').catch(console.error);

    } catch (error) {
      const safety = safetyErrorResponse(error);
      if (safety) {
        socket.emit('error', safety.body);
        acknowledge?.({ ok: false, ...safety.body });
        return;
      }
      const message = error instanceof Error ? error.message : '';
      if (
        message === 'Content or media is required' ||
        message === 'Conversation not found' ||
        message === 'Reply target is invalid for this conversation'
      ) {
        failSend(message);
        return;
      }
      console.error('chat:send_message error:', error);
      failSend('Failed to send message');
    }
  });

  // Typing indicator
  socket.on('chat:typing', async ({ conversationId, isTyping }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    const targetConversationId = typeof conversationId === 'string' ? conversationId : '';
    if (!targetConversationId) return;

    try {
      const peerId = await getConversationPeerId(targetConversationId, userId);
      if (!peerId) return;
      void warmChatSendPath(targetConversationId, userId).catch(() => undefined);
      if (!(await allowChatTypingBroadcast(userId, targetConversationId))) return;

      const payload = {
        conversationId: targetConversationId,
        userId,
        isTyping: Boolean(isTyping),
        serverEmittedAtMs: Date.now(),
      };

      // Socket.IO treats an array of rooms as a union, so a recipient joined
      // to both the chat room and their personal room receives this once.
      io.to([`chat:${targetConversationId}`, `user:${peerId}`])
        .except(socket.id)
        .emit('chat:user_typing', payload);
      logger.debug({
        event: 'chat.typing.emit',
        socketId: socket.id,
        userId,
        peerId,
        conversationId: targetConversationId,
        isTyping: Boolean(isTyping),
      });
    } catch (error) {
      console.error('chat:typing error:', error);
    }
  });

  // Mark messages as read
  socket.on('chat:mark_read', async ({ conversationId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const now = new Date();

      const senderId = await getConversationPeerId(conversationId, userId);
      if (!senderId) return;

      // Update unread messages for unread counts; premium only controls who can see receipts.
      const updated = await prisma.messages.updateMany({
        where: {
          conversationId,
          receiverId: userId,
          status: { not: 'READ' },
        },
        data: {
          status: 'READ',
          readAt: now,
          updatedAt: now,
        },
      });

      const senderCanUseReadReceipts = await getReadReceiptVisibilityCached(senderId);
      if (shouldNotifySenderAboutReadReceipt({
        updatedCount: updated.count,
        senderCanUseReadReceipts,
      })) {
        emitToUser(senderId, 'chat:messages_read', {
          conversationId,
          readBy: userId,
          readAt: now,
        });
      }
    } catch (error) {
      console.error('chat:mark_read error:', error);
    }
  });

  // Delete message
  socket.on('chat:delete_message', async ({ messageId, forEveryone }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const message = await prisma.messages.findUnique({
        where: { id: messageId },
      });

      if (!message || message.senderId !== userId) {
        socket.emit('error', { message: 'Cannot delete this message' });
        return;
      }

      const actualConversationId = message.conversationId;
      if (forEveryone) {
        await prisma.messages.update({
          where: { id: messageId },
          data: { isDeleted: true, content: '', updatedAt: new Date() },
        });
      } else {
        await prisma.messages.delete({
          where: { id: messageId },
        });
      }

      // Broadcast deletion
      io.to(`chat:${actualConversationId}`).emit('chat:message_deleted', {
        messageId,
        conversationId: actualConversationId,
        deletedBy: userId,
        forEveryone,
      });
    } catch (error) {
      console.error('chat:delete_message error:', error);
    }
  });

  // Edit message
  socket.on('chat:edit_message', async ({ messageId, content }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const message = await prisma.messages.findUnique({
        where: { id: messageId },
      });

      if (!message || message.senderId !== userId) {
        socket.emit('error', { message: 'Cannot edit this message' });
        return;
      }
      if (message.isDeleted) {
        socket.emit('error', { message: 'Cannot edit this message' });
        return;
      }

      const editedAt = new Date();
      await prisma.messages.update({
        where: { id: messageId },
        data: { content, editedAt, updatedAt: editedAt },
      });

      // Broadcast edit
      io.to(`chat:${message.conversationId}`).emit('chat:message_edited', {
        messageId,
        conversationId: message.conversationId,
        content,
        editedAt,
      });
    } catch (error) {
      console.error('chat:edit_message error:', error);
    }
  });

  // React to message
  socket.on('chat:react', async ({ messageId, emoji }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (!emoji) {
      socket.emit('error', { message: 'Emoji is required' });
      return;
    }

    try {
      const message = await prisma.messages.findUnique({
        where: { id: messageId },
        select: { id: true, conversationId: true, senderId: true, receiverId: true, isDeleted: true },
      });
      if (!message || message.isDeleted || (message.senderId !== userId && message.receiverId !== userId)) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }
      const conversationId = message.conversationId;

      const existingReaction = await prisma.message_reactions.findUnique({
        where: {
          messageId_userId: { messageId, userId },
        },
      });

      let action: string;

      if (existingReaction) {
        if (existingReaction.emoji === emoji) {
          await prisma.message_reactions.delete({
            where: { id: existingReaction.id },
          });
          action = 'removed';
        } else {
          await prisma.message_reactions.update({
            where: { id: existingReaction.id },
            data: { emoji },
          });
          action = 'updated';
        }
      } else {
        await prisma.message_reactions.create({
          data: { id: randomUUID(), messageId, userId, emoji },
        });
        action = 'added';
      }

      // Broadcast reaction
      io.to(`chat:${conversationId}`).emit('chat:message_reaction', {
        messageId,
        conversationId,
        userId,
        emoji,
        action,
      });
    } catch (error) {
      console.error('chat:react error:', error);
    }
  });

  // Recipient acknowledges receipt of message(s) so the sender sees delivered ticks
  socket.on('chat:delivered', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    const payload = data && typeof data === 'object' ? data : {};
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
    if (!conversationId) return;

    try {
      const peerId = await getConversationPeerId(conversationId, userId);
      if (!peerId) return;

      const now = new Date();
      const updated = await prisma.messages.updateMany({
        where: {
          conversationId,
          receiverId: userId,
          status: 'SENT',
          isDeleted: false,
        },
        data: { status: 'DELIVERED', deliveredAt: now, updatedAt: now },
      });
      if (updated.count === 0) return;

      if (messageId) {
        emitToUser(peerId, 'chat:message_delivered', {
          messageId,
          conversationId,
          deliveredAt: now,
        });
      }
      emitToUser(peerId, 'chat:messages_delivered', {
        conversationId,
        deliveredTo: userId,
        deliveredAt: now,
      });
    } catch (error) {
      console.error('chat:delivered error:', error);
    }
  });

  // On-demand presence lookup, restricted to conversation partners and connections
  socket.on('user:check_status', async (data) => {
    const requesterId = getSocketUserId(socket);
    if (!requesterId) return;

    const payload = data && typeof data === 'object' ? data : {};
    const targetUserId = typeof payload.userId === 'string' ? payload.userId : '';
    if (!targetUserId || targetUserId === requesterId) return;

    try {
      const conversation = await prisma.conversations.findFirst({
        where: {
          OR: [
            { participant1Id: requesterId, participant2Id: targetUserId },
            { participant1Id: targetUserId, participant2Id: requesterId },
          ],
        },
        select: { id: true },
      });

      if (!conversation) {
        const connection = await prisma.connections.findFirst({
          where: {
            status: 'accepted',
            OR: [
              { requesterId, addresseeId: targetUserId },
              { requesterId: targetUserId, addresseeId: requesterId },
            ],
          },
          select: { id: true },
        });
        if (!connection) return;
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, isOnline: true, lastActiveAt: true },
      });
      if (!targetUser) return;

      const sharedPresence = await getSharedChatPresence(targetUserId);

      socket.emit('user:status', {
        userId: targetUser.id,
        isOnline: sharedPresence ?? Boolean(targetUser.isOnline),
        lastActiveAt: targetUser.lastActiveAt ? targetUser.lastActiveAt.toISOString() : null,
      });
    } catch (error) {
      console.error('user:check_status error:', error);
    }
  });

  // ============================================
  // GROUP CHAT SOCKET EVENTS
  // ============================================

  // Join group chat room
  socket.on('group:join', async ({ groupId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    // Verify user is member of group
    const membership = await prisma.group_members.findUnique({
      where: {
        groupId_userId: { groupId, userId },
      },
    });

    if (!membership) {
      socket.emit('error', { message: 'Not a member of this group' });
      return;
    }

    socket.join(`group:${groupId}`);

    // Track online users
    if (!groupOnlineCounts.has(groupId)) {
      groupOnlineCounts.set(groupId, new Set());
    }
    groupOnlineCounts.get(groupId)!.add(userId);

    const onlineCount = groupOnlineCounts.get(groupId)!.size;

    // Notify group of new user
    io.to(`group:${groupId}`).emit('group:user_joined', {
      groupId,
      userId,
      onlineCount,
    });

    console.log(`User ${userId} joined group:${groupId}`);
  });

  // Leave group chat room
  socket.on('group:leave', ({ groupId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    socket.leave(`group:${groupId}`);

    // Update online count
    if (groupOnlineCounts.has(groupId)) {
      groupOnlineCounts.get(groupId)!.delete(userId);
      const onlineCount = groupOnlineCounts.get(groupId)!.size;
      
      io.to(`group:${groupId}`).emit('group:user_left', {
        groupId,
        userId,
        onlineCount,
      });
    }
  });

  // Group typing indicator
  socket.on('group:typing', async ({ groupId, isTyping }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;
    if (!groupId || !socket.rooms.has(`group:${groupId}`)) {
      return;
    }

    try {
      const user = await groupTypingUserMemo.get(userId, () =>
        prisma.user.findUnique({
          where: { id: userId },
          select: chatUserSelect,
        })
      );
      if (!user) return;

      socket.to(`group:${groupId}`).emit('group:user_typing', {
        groupId,
        user,
        isTyping: Boolean(isTyping),
      });
    } catch (error) {
      console.error('group:typing error:', error);
    }
  });

  // Send group message
  socket.on('group:message', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const { groupId, content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId, tempId } = data;

      // Verify membership
      const membership = await prisma.group_members.findUnique({
        where: {
          groupId_userId: { groupId, userId },
        },
      });

      if (!membership) {
        socket.emit('error', { message: 'Not a member of this group' });
        return;
      }

      const group = await prisma.groups.findUnique({
        where: { id: groupId },
        select: {
          id: true,
          name: true,
          iconImage: true,
          imageUrl: true,
          coverImage: true,
          group_members: {
            where: {
              userId: { not: userId },
            },
            select: { userId: true },
          },
        },
      });

      if (!group) {
        socket.emit('error', { message: 'Group not found' });
        return;
      }
      const replyMessageId = replyToId ? String(replyToId).trim() : null;
      const replyMessage = replyMessageId
        ? await prisma.group_messages.findFirst({
            where: { id: replyMessageId, groupId, isDeleted: false },
            select: { id: true, content: true, senderId: true },
          })
        : null;
      if (replyMessageId && !replyMessage) {
        socket.emit('error', { message: 'Reply target is not in this group' });
        return;
      }

      // Create message in database
      const message = await prisma.group_messages.create({
        data: {
          id: randomUUID(),
          groupId,
          senderId: userId,
          content: content || '',
          contentType: contentType || 'text',
          mediaUrl,
          mediaType,
          fileName,
          fileSize,
          replyToId: replyMessageId || undefined,
          updatedAt: new Date(),
        },
        include: {
          users: {
            select: chatUserSelect,
          },
          group_messages: {
            select: {
              id: true,
              content: true,
              senderId: true,
            },
          },
        },
      });

      const messagePayload = {
        id: message.id,
        groupId: message.groupId,
        senderId: message.senderId,
        sender: (message as typeof message & { users: unknown }).users,
        content: message.content,
        contentType: message.contentType,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        fileName: message.fileName,
        fileSize: message.fileSize,
        replyToId: message.replyToId,
        replyTo: (message as typeof message & { group_messages: unknown }).group_messages || replyMessage,
        reactions: [],
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
        tempId,
      };

      // Broadcast to group
      const groupImage = group.iconImage || group.imageUrl || group.coverImage || undefined;
      io.to(`group:${groupId}`).emit('group:new_message', {
        ...messagePayload,
        groupName: group.name,
        groupImage: groupImage || '',
      });

      const sender = (message as typeof message & { users: any }).users;
      const recipientIds = group.group_members.map((member: { userId: string }) => member.userId);
      if (recipientIds.length > 0) {
        pushNotificationService.pushGroupMessageToUsers(
          recipientIds,
          group.name,
          sender?.name || sender?.username || 'Someone',
          buildGroupMessagePreview(message.content, message.contentType),
          groupId,
          userId,
          groupImage,
          sender?.profileImage || undefined
        ).catch(console.error);
      }

      console.log(`Group message sent in ${groupId} by user ${userId}`);
    } catch (error) {
      console.error('group:message error:', error);
      socket.emit('error', { message: 'Failed to send group message' });
    }
  });

  // Delete group message
  socket.on('group:delete_message', async ({ groupId, messageId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const message = await prisma.group_messages.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          groupId: true,
          senderId: true,
          isDeleted: true,
          groups: { select: { creatorId: true } },
        },
      });

      if (!message || (groupId && message.groupId !== groupId)) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }

      const membership = await prisma.group_members.findUnique({
        where: { groupId_userId: { groupId: message.groupId, userId } },
        select: { role: true },
      });
      if (!membership) {
        socket.emit('error', { message: 'Not a member of this group' });
        return;
      }

      const role = message.groups.creatorId === userId ? 'owner' : String(membership.role || '').toLowerCase();
      const canModerate = ['owner', 'admin', 'moderator'].includes(role);
      if (message.senderId !== userId && !canModerate) {
        socket.emit('error', { message: 'Cannot delete this message' });
        return;
      }

      if (!message.isDeleted) {
        await prisma.group_messages.update({
          where: { id: messageId },
          data: { isDeleted: true, content: '', updatedAt: new Date() },
        });
      }

      io.to(`group:${message.groupId}`).emit('group:message_deleted', {
        groupId: message.groupId,
        messageId,
        deletedBy: userId,
      });
    } catch (error) {
      console.error('group:delete_message error:', error);
      socket.emit('error', { message: 'Failed to delete group message' });
    }
  });

  // ============================================
  // REELS SOCKET EVENTS
  // ============================================

  // Join reel room (for live engagement updates)
  socket.on('reel:join', async ({ reelId }) => {
    const viewerId = getSocketUserId(socket);
    if (!reelId) return;

    try {
      const reel = await prisma.reels.findUnique({
        where: { id: reelId },
        select: { authorId: true, visibility: true, status: true, publishedAt: true },
      });
      if (!reel || !(await canViewReel(reel, viewerId))) {
        socket.emit('error', { message: 'Reel not found' });
        return;
      }
      socket.join(`reel:${reelId}`);
    } catch (error) {
      console.error('reel:join error:', error);
      socket.emit('error', { message: 'Failed to join reel' });
    }
  });

  // Leave reel room
  socket.on('reel:leave', ({ reelId }) => {
    socket.leave(`reel:${reelId}`);
  });

  // Reel like via WebSocket
  socket.on('reel:like', async ({ reelId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const result = await toggleReelLikeWithFanout(reelId, userId);
      if (!result) {
        socket.emit('error', { message: 'Reel not found' });
        return;
      }
      console.log(`Reel ${reelId} ${result.liked ? 'liked' : 'unliked'} by user ${userId}`);
    } catch (error) {
      console.error('reel:like error:', error);
      socket.emit('error', { message: 'Failed to like reel' });
    }
  });

  // Reel comment via WebSocket
  socket.on('reel:comment', async ({ reelId, content, parentId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      if (!content || typeof content !== 'string') {
        socket.emit('error', { message: 'Content is required' });
        return;
      }

      const result = await createReelCommentWithFanout(reelId, userId, content, parentId);
      if (!result) {
        socket.emit('error', { message: 'Reel not found' });
        return;
      }
      console.log(`Reel comment on ${reelId} by user ${userId}`);
    } catch (error) {
      console.error('reel:comment error:', error);
      const message = error instanceof Error ? error.message : '';
      if (message === 'REEL_COMMENTS_DISABLED') {
        socket.emit('error', { message: 'Comments are disabled' });
        return;
      }
      if (message === 'REEL_COMMENT_PARENT_NOT_FOUND') {
        socket.emit('error', { message: 'Parent comment not found' });
        return;
      }
      socket.emit('error', { message: 'Failed to comment on reel' });
    }
  });

  // ============================================
  // OTHER EVENTS
  // ============================================

  // Story view - record view and notify story author for live view count
  socket.on('story:view', async ({ storyId, duration }: { storyId: string; duration?: number }) => {
    const viewerUserId = getSocketUserId(socket);
    if (!viewerUserId) return;

    try {
      const story = await prisma.stories.findFirst({
        where: { id: storyId, expiresAt: { gt: new Date() } },
        select: { id: true, authorId: true, visibility: true, expiresAt: true, viewsCount: true },
      });
      if (!story || !(await canViewStory(story, viewerUserId))) return;

      // Don't count own views
      if (story.authorId === viewerUserId) return;

      let isNewView = false;
      try {
        await prisma.story_views.create({
          data: {
            storyId,
            viewerId: viewerUserId,
          },
        });
        isNewView = true;
      } catch (error: any) {
        if (error.code !== 'P2002') {
          throw error;
        }
      }

      const viewsCount = await prisma.story_views.count({
        where: { storyId },
      });

      if (story.viewsCount !== viewsCount) {
        await prisma.stories.update({
          where: { id: storyId },
          data: { viewsCount },
        });
      }

      // Notify story author for live view count update
      if (isNewView) {
        io.to(`user:${story.authorId}`).emit('story:viewed', {
          storyId,
          viewsCount,
        });
      }
    } catch (err) {
      console.error('story:view error:', err);
    }
  });

  // Location update
  socket.on('location:update', async (data) => {
    const userId = getSocketUserId(socket);
    if (!userId) {
      socket.emit('error', { message: 'Authentication required for location updates' });
      return;
    }

    const validation = validateSocketLocationPayload(data);
    if (!validation.ok) {
      socket.emit('error', { message: validation.error || 'Invalid location update payload' });
      return;
    }

    if (shouldThrottleSocketLocationUpdate(socketLocationUpdateTimestamps, userId)) {
      socket.emit('error', { message: 'Location updates are rate limited' });
      return;
    }

    try {
      const user = await getRealtimeLocationUser(userId);
      if (!user || user.shareLocationPublic !== true) {
        return;
      }

      const location = buildCoarseSocketLocation(validation.value || {}, user);
      const payload = buildSocketLocationEventPayload(user, location);
      if (!payload) {
        return;
      }

      const connectionIds = await getAcceptedConnectionIdsForRealtime(user.id);
      const rooms = buildAuthorizedPresenceRooms(connectionIds, location);
      for (const room of rooms) {
        socket.to(room).emit('user:location_changed', payload);
      }
    } catch (error) {
      console.error('location:update error:', error);
      socket.emit('error', { message: 'Failed to process location update' });
    }
  });

  socket.on('disconnect', (reason) => {
    const userId = socketUsers.get(socket.id);

    agentRealtimeVoiceService.cleanupSocket(socket.id);
    
    if (userId) {
      // Remove from user sockets
      userSockets.get(userId)?.delete(socket.id);
      const isLocallyOffline = userSockets.get(userId)?.size === 0;
      if (isLocallyOffline) {
        userSockets.delete(userId);
        socketLocationUpdateTimestamps.delete(userId);
      }
      void unregisterSharedChatPresence(userId, socket.id).then((isSharedOffline) => {
        if (!(isSharedOffline ?? isLocallyOffline)) return;
        prisma.user.update({
          where: { id: userId },
          data: { isOnline: false, lastActiveAt: new Date() },
        }).catch((error) => {
          console.error('Failed to mark socket user offline:', error);
        });
        emitPresenceToAuthorizedRooms(socket, userId, 'user:offline').catch((error) => {
          console.error('Failed to emit scoped offline presence:', error);
        });
        emitChatPresence(userId, false).catch((error) => {
          console.error('Failed to emit chat presence offline:', error);
        });
      });
      socketUsers.delete(socket.id);

      // Update online counts for any groups
      groupOnlineCounts.forEach((users, groupId) => {
        if (users.has(userId)) {
          users.delete(userId);
          io.to(`group:${groupId}`).emit('group:user_left', {
            groupId,
            userId,
            onlineCount: users.size,
          });
        }
      });
    }

    console.log(`🔌 Socket disconnected: ${socket.id} (${reason})`);
  });
});

const DEFAULT_REQUEST_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const STORY_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const POST_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const CHAT_UPLOAD_MAX_BYTES = 150 * 1024 * 1024;

const getRequestMaxBytes = (req: Request): number => {
  if (req.method !== 'POST') {
    return DEFAULT_REQUEST_MAX_BYTES;
  }

  const path = req.path.replace(/\/$/, '');
  if (path === '/api/posts') {
    return POST_UPLOAD_MAX_BYTES;
  }
  if (path === '/api/reels' || path === '/api/chat/upload' || path === '/api/upload/chat') {
    return CHAT_UPLOAD_MAX_BYTES;
  }
  if (path === '/api/stories') {
    return STORY_UPLOAD_MAX_BYTES;
  }
  if (
    path === '/api/upload/avatar'
    || path === '/api/upload/banner'
    || path === '/api/upload/certificate'
    || path === '/api/upload/project'
    || path === '/api/upload/logo'
    || path === '/api/upload/group-icon'
    || path === '/api/upload/group-cover'
    || /^\/api\/groups\/[^/]+\/upload\/(icon|cover)$/.test(path)
    || path === '/api/users/me/avatar'
    || path === '/api/users/me/banner'
  ) {
    return IMAGE_UPLOAD_MAX_BYTES;
  }
  if (/^\/api\/agent\/sessions\/[^/]+\/voice$/.test(path)) {
    return 20 * 1024 * 1024;
  }
  return DEFAULT_REQUEST_MAX_BYTES;
};

app.use('/mcp', mcpCorsHeaders);
app.use(httpLogger);
app.use(metricsMiddleware);
app.use(helmet());
app.use(requestSizeGuard(getRequestMaxBytes));
app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    callback(null, isAllowedRequestOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-CSRF-Token',
    'X-Auth-Token-Transport',
    'X-Firebase-AppCheck',
    'X-Vormex-Client',
    'X-Vormex-Install-Id',
    'X-Vormex-Platform',
    'X-Vormex-App-Version',
    'X-Vormex-App-Build',
  ],
}));

app.use('/api/proximity/v1', express.json({
  limit: '16kb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = Buffer.from(buf);
  },
}));
app.use('/api/proximity/v1', (error: any, _req: Request, res: Response, next: (error?: any) => void) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PROXIMITY_INVALID_REQUEST', message: 'Request is too large', retryable: false } });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: { code: 'PROXIMITY_INVALID_REQUEST', message: 'Request body must be valid JSON', retryable: false } });
    return;
  }
  next(error);
});
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = Buffer.from(buf);
  },
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use('/api', (_req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use('/api', validateRequestInput);

/**
 * Health check endpoint
 * Tests database connection and returns server status
 */
app.get('/api/health/live', async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

app.get('/api/health/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [redisHealth, backgroundProcesses] = await Promise.all([
      getRedisHealth(),
      getBackgroundProcessesHealth(),
    ]);
    const redisReady = Object.values(redisHealth.roles).every(
      (role) => role.status === 'connected' || role.status === 'disabled'
    );
    const ready = redisReady && backgroundProcesses.healthy;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'error',
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ event: 'health.readiness_failed', error });
    res.status(503).json({
      status: 'error',
      timestamp: Date.now(),
    });
  }
});

app.get('/api/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Test Prisma connection
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: 'ok',
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ event: 'health.database_failed', error });
    res.status(503).json({
      status: 'error',
      timestamp: Date.now(),
    });
  }
});

app.get(
  '/metrics',
  requireMetricsIpAllowList,
  authenticate,
  requireAdmin,
  async (_req: Request, res: Response): Promise<void> => {
    await collectDbConnectionMetrics();
    res.setHeader('Content-Type', register.contentType);
    res.status(200).send(await register.metrics());
  }
);

// API documentation is disabled by default in production to avoid exposing the
// complete attack surface. Enable it deliberately for a protected environment.
if (process.env.NODE_ENV !== 'production' || process.env.API_DOCS_ENABLED === 'true') {
  setupSwagger(app, PORT);
}
app.use('/api', optionalAppCheck, botGuard, optionalAuth, generalApiRateLimit);
app.use('/api/ai', validateAIRequestInput);
app.use('/api/agent', validateAIRequestInput);
app.use('/api/talk', validateAIRequestInput);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/auth', passwordRoutes);
app.use('/api/auth', oauthRoutes);
app.use('/api/auth', verificationRoutes);
app.use('/api/integrations', integrationsRoutes);
app.use('/api', profileRoutes);
app.use('/api', professionalFieldsRoutes);
app.use('/api', uploadRoutes);
app.use('/api/engagement', engagementRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/saved', savedRoutes);
app.use('/api/mentions', mentionsRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/follow', followRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/people', peopleRoutes);
app.use('/api/matching', matchingRoutes);
app.use('/api/accountability', accountabilityRoutes);
app.use('/api/skills', skillsRoutes);
app.use('/api/skill-swap', skillSwapRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/hackathons', hackathonsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/college-communities', collegeCommunitiesRoutes);
app.use('/api/circles', circlesRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/proximity/v1', proximityRoutes);
app.use('/api/social-proof', socialProofRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/identity', identityRoutes);
app.use('/api/safety', safetyRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/premium', premiumRoutes);
app.use('/api/badges', badgesRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/learning', learningRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/interviews', interviewsRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/ai/chat', aiChatRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/talk', talkRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/reels', reelsRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/ads', managedAdsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/daily-hooks', dailyHooksRoutes);
app.use('/api/public/discovery', publicDiscoveryRoutes);
app.use('/api/discovery', recommendationRoutes);

registerPublicDiscoveryMcp(app);

// 404 handler for undefined routes
app.use(notFoundHandler);

// Error handling middleware (must be last)
app.use(errorHandler);
const server = httpServer;

const handleStartupError = async (error: NodeJS.ErrnoException): Promise<void> => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Another process is already listening on http://${HOST}:${PORT}.`);
    console.error('Stop that process or run the backend on a different port, for example:');
    console.error('  PORT=5001 npm run dev');
  } else {
    console.error('Failed to start HTTP server:', error);
  }

  try {
    await disconnectPrisma();
    console.log('Database connection closed.');
  } catch (disconnectError) {
    console.error('Error closing database connection after startup failure:', disconnectError);
  }

  process.exit(1);
};

const onStartupError = (error: NodeJS.ErrnoException): void => {
  void handleStartupError(error);
};

server.once('error', onStartupError);

async function startServer(): Promise<void> {
  try {
    await redisStartupPromise;
  } catch (error) {
    if (isRedisRequired()) {
      console.error('Failed to initialize Redis realtime infrastructure:', error);
      await disconnectPrisma();
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.warn({
      event: 'redis.api.disabled',
      message,
    });
  }

  // Optional and fault-isolated: proximity failure must never block the core API.
  await connectProximityRedis().catch((error) => logger.warn({ event: 'proximity.redis.disabled', message: error instanceof Error ? error.message : String(error) }));

  server.listen(Number(PORT), HOST, (): void => {
    server.removeListener('error', onStartupError);

    console.log(`
🚀 Server is running!
📍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Server URL: http://${HOST}:${PORT}
📊 Health Check: http://${HOST}:${PORT}/api/health
📚 API Docs: http://${HOST}:${PORT}/api-docs
🔌 WebSocket: ws://${HOST}:${PORT}
  `);
  });
}

// Start server
void startServer();

// Graceful shutdown
let shutdownStarted = false;

function closeHttpServer(timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn({
        event: 'http_server.close_timeout',
        timeoutMs,
      });
      resolve();
    }, timeoutMs);

    server.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    });
  });
}

const gracefulShutdown = async (reason: string, exitCode = 0): Promise<void> => {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  logger.info({
    event: 'process.shutdown.start',
    reason,
    exitCode,
  });

  try {
    await closeHttpServer();
    logger.info({ event: 'http_server.closed', reason });

    await disconnectRedisClients();
    await closeProximityQueues();
    await closeProximityRedis();
    await Promise.allSettled(getAllQueues().map((queue) => queue.close()));
    await disconnectPrisma();
    logger.info({
      event: 'process.shutdown.complete',
      reason,
      exitCode,
    });
    process.exit(exitCode);
  } catch (error) {
    logger.error({
      event: 'process.shutdown.error',
      reason,
      error,
    });
    process.exit(1);
  }
};

installProcessErrorHandlers({
  shutdown: async (reason) => {
    await gracefulShutdown(reason, 1);
  },
});

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => void gracefulShutdown('SIGINT', 0));
