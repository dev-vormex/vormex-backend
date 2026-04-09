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
import { prisma, disconnectPrisma } from './config/prisma';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { httpLogger } from './lib/logger';
import { metricsMiddleware } from './middleware/metrics.middleware';
import authRoutes from './routes/auth.routes';
import passwordRoutes from './routes/password.routes';
import oauthRoutes from './routes/oauth.routes';
import verificationRoutes from './routes/verification.routes';
import integrationsRoutes from './routes/integrations.routes';
import profileRoutes from './routes/profile.routes';
import professionalFieldsRoutes from './routes/professional-fields.routes';
import uploadRoutes from './routes/upload.routes';
import engagementRoutes from './routes/engagement.routes';
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
import groupsRoutes from './routes/groups.routes';
import onboardingRoutes from './routes/onboarding.routes';
import gamesRoutes from './routes/games.routes';
import locationRoutes from './routes/location.routes';
import socialProofRoutes from './routes/social-proof.routes';
import notificationsRoutes from './routes/notifications.routes';
import reportsRoutes from './routes/reports.routes';
import storeRoutes from './routes/store.routes';
import badgesRoutes from './routes/badges.routes';
import referralsRoutes from './routes/referrals.routes';
import learningRoutes from './routes/learning.routes';
import jobsRoutes from './routes/jobs.routes';
import interviewsRoutes from './routes/interviews.routes';
import challengesRoutes from './routes/challenges.routes';
import aiChatRoutes from './routes/ai-chat.routes';
import agentRoutes from './routes/agent.routes';
import devicesRoutes from './routes/devices.routes';
import reelsRoutes from './routes/reels.routes';
import audioRoutes from './routes/audio.routes';
import adminRoutes from './routes/admin.routes';
import dailyHooksRoutes from './routes/daily-hooks.routes';
import premiumRoutes from './routes/premium.routes';
import { setupSwagger } from './swagger';
import { setIO } from './sockets';
import { register } from './infrastructure/metrics/registry';
import { getAllQueues } from './infrastructure/queue/queues';
import {
  connectRedisClients,
  disconnectRedisClients,
  isRedisEnabled,
  redisPub,
  redisSub,
} from './infrastructure/redis/client';
import { initializeRealtimeSubscriptions } from './infrastructure/realtime/subscriber';
import { requestSizeGuard } from './infrastructure/security/request-size.middleware';
import { agentRealtimeVoiceService } from './agent/realtime-voice.service';
import { createRateLimitMiddleware } from './middleware/rate-limit.middleware';
import { getPostMetadata, mapPollOptionsForResponse } from './utils/post.util';
import { pushNotificationService } from './services/push-notification.service';
import { enqueueCacheInvalidation, enqueueRealtimeFanout } from './outbox/helpers';

// Validate required environment variables
const requiredEnvVars = [
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'FRONTEND_URL',
  'ENCRYPTION_KEY',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Validate ENCRYPTION_KEY format (must be 64 hex characters)
if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length !== 64) {
  throw new Error('ENCRYPTION_KEY must be exactly 64 characters (32 bytes in hex)');
}

const app: Express = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 5000;

app.set('trust proxy', true);

// Socket.IO Setup - allow all origins so mobile (Android/iOS) can connect (they may not send standard Origin)
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: true, // Allow any origin - required for Android/iOS real-time chat
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Share Socket.IO instance with controllers via the sockets module
setIO(io);

if (isRedisEnabled() && redisPub && redisSub) {
  void connectRedisClients()
    .then(async () => {
      io.adapter(createAdapter(redisPub, redisSub));
      await initializeRealtimeSubscriptions(io);
    })
    .catch((error) => {
      console.error('Failed to initialize Redis realtime infrastructure:', error);
    });
}

// Import JWT verification for socket auth
import { verifyToken } from './utils/jwt.util';

// Import activity service for engagement tracking
import { recordActivity } from './services/activity.service';
import { updateEngagementStreak } from './controllers/engagement.controller';

// Track user socket mappings
const userSockets = new Map<string, Set<string>>(); // userId -> Set of socketIds
const socketUsers = new Map<string, string>(); // socketId -> userId

// Helper to get userId from socket
const getSocketUserId = (socket: any): string | null => {
  return socketUsers.get(socket.id) || null;
};

// Helper to emit to user by userId (all their connected sockets)
const emitToUser = (userId: string, event: string, data: any) => {
  const userSocketIds = userSockets.get(userId);
  if (userSocketIds) {
    userSocketIds.forEach(socketId => {
      io.to(socketId).emit(event, data);
    });
  }
};

// User select for chat queries
const chatUserSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isOnline: true,
  lastActiveAt: true,
};

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
  return prisma.$transaction(async (tx) => {
    const post = await tx.post.findFirst({
      where: { id: postId, isActive: true },
      select: { id: true, authorId: true },
    });

    if (!post) {
      return null;
    }

    const existingLike = await tx.postLike.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    let liked = false;
    if (existingLike) {
      await tx.postLike.delete({
        where: { postId_userId: { postId, userId } },
      });
    } else {
      await tx.postLike.create({
        data: { postId, userId },
      });
      liked = true;
    }

    const likesCount = await tx.postLike.count({ where: { postId } });
    await tx.post.update({
      where: { id: postId },
      data: { likesCount },
    });

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: `post.${eventName}.fanout`,
      envelopes: [
        {
          event: eventName,
          rooms: [feedRealtimeRoom, `post:${postId}`],
          payload: {
            postId,
            userId,
            liked,
            reactionType: liked ? reactionType : null,
            likesCount,
            reactionSummary: [],
          },
        },
      ],
    });

    await enqueueCacheInvalidation(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: 'post.engagement.cache.invalidate',
      tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
    });

    return {
      liked,
      likesCount,
      reactionType: liked ? reactionType : null,
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
      select: { id: true, authorId: true },
    });

    if (!post) {
      return null;
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

    const envelopes: Array<Record<string, unknown>> = [
      {
        event: 'comment:created',
        rooms: [feedRealtimeRoom, `post:${postId}`],
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
      tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
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
      select: { id: true, postId: true },
    });

    if (!comment || comment.postId !== postId) {
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
      select: { id: true, authorId: true, metadata: true },
    });

    if (!post) {
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

    await enqueueRealtimeFanout(tx as any, {
      aggregateType: 'post',
      aggregateId: postId,
      eventType: 'post.poll.vote.fanout',
      envelopes: [
        {
          event: 'poll:updated',
          rooms: [feedRealtimeRoom, `post:${postId}`],
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
      tags: [`feed:${post.authorId}`, `user:${post.authorId}`],
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
      select: { id: true, authorId: true },
    });

    if (!reel) {
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
      select: { id: true, authorId: true, allowComments: true },
    });

    if (!reel) {
      return null;
    }
    if (!reel.allowComments) {
      throw new Error('REEL_COMMENTS_DISABLED');
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

// Socket.IO connection handling
io.on('connection', async (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // Handle authentication
  const token = socket.handshake.auth?.token;
  let userId: string | null = null;

  if (token) {
    try {
      const decoded = verifyToken(token);
      userId = String(decoded.userId);
      
      // Track socket-user mapping
      socketUsers.set(socket.id, userId);
      if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
      }
      userSockets.get(userId)!.add(socket.id);
      
      // Join user's personal room for notifications
      socket.join(`user:${userId}`);
      
      console.log(`✅ Socket ${socket.id} authenticated as user ${userId}`);
    } catch (error) {
      console.error('Socket auth failed:', error);
    }
  }

  socket.on('agent:join_session', ({ sessionId }) => {
    const authenticatedUserId = getSocketUserId(socket);
    if (!authenticatedUserId || !sessionId) {
      return;
    }
    socket.join(`agent:session:${sessionId}`);
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
  socket.on('post:join', ({ postId }) => {
    socket.join(`post:${postId}`);
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
  socket.on('chat:join', (data) => {
    const conversationId = data?.conversationId ?? data;
    if (conversationId && typeof conversationId === 'string') {
      socket.join(`chat:${conversationId}`);
      console.log(`Socket ${socket.id} joined chat:${conversationId}`);
    } else {
      console.warn('chat:join received invalid data:', JSON.stringify(data));
    }
  });

  // Leave chat room
  socket.on('chat:leave', (data) => {
    const conversationId = data?.conversationId ?? data;
    if (conversationId && typeof conversationId === 'string') {
      socket.leave(`chat:${conversationId}`);
    }
  });

  // Send chat message
  socket.on('chat:send_message', async (data) => {
    const senderId = getSocketUserId(socket);
    if (!senderId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const { conversationId, content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId } = data;

      // Verify user is part of conversation
      const conversation = await prisma.conversations.findFirst({
        where: {
          id: conversationId,
          OR: [
            { participant1Id: senderId },
            { participant2Id: senderId },
          ],
        },
      });

      if (!conversation) {
        socket.emit('error', { message: 'Conversation not found' });
        return;
      }

      const receiverId = conversation.participant1Id === senderId
        ? conversation.participant2Id
        : conversation.participant1Id;

      // Create message in database
      const message = await prisma.messages.create({
        data: {
          id: randomUUID(),
          conversationId,
          senderId,
          receiverId,
          content: content || '',
          contentType: contentType || 'text',
          mediaUrl,
          mediaType,
          fileName,
          fileSize,
          replyToId,
          status: 'SENT',
          updatedAt: new Date(),
        },
        include: {
          messages: {
            select: {
              id: true,
              content: true,
              contentType: true,
              senderId: true,
            },
          },
        },
      });

      // Update conversation lastMessageAt
      await prisma.conversations.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date(), updatedAt: new Date() },
      });

      // Get sender info
      const sender = await prisma.user.findUnique({
        where: { id: senderId },
        select: chatUserSelect,
      });

      const messagePayload = {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        receiverId: message.receiverId,
        content: message.content,
        contentType: message.contentType,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        fileName: message.fileName,
        fileSize: message.fileSize,
        status: message.status,
        deliveredAt: message.deliveredAt?.toISOString(),
        readAt: message.readAt?.toISOString(),
        isDeleted: message.isDeleted,
        replyToId: message.replyToId,
        replyTo: (message as typeof message & { messages: unknown }).messages,
        sender,
        reactions: [],
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
      };

      // Broadcast to conversation room
      io.to(`chat:${conversationId}`).emit('chat:new_message', {
        conversationId,
        message: messagePayload,
      });

      emitToUser(senderId, 'chat:new_message', {
        conversationId,
        message: messagePayload,
      });

      // Also emit to receiver's personal room (for notifications when not in chat)
      emitToUser(receiverId, 'chat:notification', {
        type: 'new_message',
        conversationId,
        message: messagePayload,
        sender,
      });

      if (sender) {
        const preview = content ? (content.length > 100 ? content.substring(0, 97) + '...' : content) : 'Sent you a message';
        pushNotificationService.pushNewMessage(
          receiverId,
          sender.name || sender.username || 'Someone',
          preview,
          conversationId,
          senderId,
          sender.profileImage || undefined
        ).catch(console.error);
      }

      // Record messaging activity and update streak (non-blocking)
      recordActivity(senderId, 'message', 1).catch(console.error);
      updateEngagementStreak(senderId, 'messaging').catch(console.error);

      console.log(`Message sent in conversation ${conversationId} by user ${senderId}`);
    } catch (error) {
      console.error('chat:send_message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Typing indicator
  socket.on('chat:typing', async ({ conversationId, isTyping }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    socket.to(`chat:${conversationId}`).emit('chat:user_typing', {
      conversationId,
      userId,
      isTyping,
    });
  });

  // Mark messages as read
  socket.on('chat:mark_read', async ({ conversationId }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
      const now = new Date();
      
      // Get conversation to find sender
      const conversation = await prisma.conversations.findFirst({
        where: {
          id: conversationId,
          OR: [
            { participant1Id: userId },
            { participant2Id: userId },
          ],
        },
      });

      if (!conversation) return;

      const senderId = conversation.participant1Id === userId
        ? conversation.participant2Id
        : conversation.participant1Id;

      // Update unread messages
      await prisma.messages.updateMany({
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

      // Notify sender that messages were read
      io.to(`chat:${conversationId}`).emit('chat:messages_read', {
        conversationId,
        readBy: userId,
        readAt: now,
      });

      // Also notify sender directly
      emitToUser(senderId, 'chat:messages_read', {
        conversationId,
        readBy: userId,
        readAt: now,
      });
    } catch (error) {
      console.error('chat:mark_read error:', error);
    }
  });

  // Delete message
  socket.on('chat:delete_message', async ({ messageId, conversationId, forEveryone }) => {
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
      io.to(`chat:${conversationId}`).emit('chat:message_deleted', {
        messageId,
        conversationId,
        deletedBy: userId,
        forEveryone,
      });
    } catch (error) {
      console.error('chat:delete_message error:', error);
    }
  });

  // Edit message
  socket.on('chat:edit_message', async ({ messageId, conversationId, content }) => {
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

      const updated = await prisma.messages.update({
        where: { id: messageId },
        data: { content, updatedAt: new Date() },
      });

      // Broadcast edit
      io.to(`chat:${conversationId}`).emit('chat:message_edited', {
        messageId,
        conversationId,
        content,
        editedAt: updated.updatedAt,
      });
    } catch (error) {
      console.error('chat:edit_message error:', error);
    }
  });

  // React to message
  socket.on('chat:react', async ({ messageId, conversationId, emoji }) => {
    const userId = getSocketUserId(socket);
    if (!userId) return;

    try {
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

  // ============================================
  // GROUP CHAT SOCKET EVENTS
  // ============================================

  // Track group online counts
  const groupOnlineCounts = new Map<string, Set<string>>();

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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: chatUserSelect,
    });

    socket.to(`group:${groupId}`).emit('group:user_typing', {
      groupId,
      user,
      isTyping,
    });
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
          replyToId,
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
        replyTo: (message as typeof message & { group_messages: unknown }).group_messages,
        reactions: [],
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
        tempId,
      };

      // Broadcast to group
      io.to(`group:${groupId}`).emit('group:new_message', messagePayload);

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

    // Broadcast deletion
    io.to(`group:${groupId}`).emit('group:message_deleted', {
      groupId,
      messageId,
      deletedBy: userId,
    });
  });

  // ============================================
  // REELS SOCKET EVENTS
  // ============================================

  // Join reel room (for live engagement updates)
  socket.on('reel:join', ({ reelId }) => {
    socket.join(`reel:${reelId}`);
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
        select: { id: true, authorId: true, viewsCount: true },
      });
      if (!story) return;

      // Don't count own views
      if (story.authorId === viewerUserId) return;

      const newViewsCount = story.viewsCount + 1;
      await prisma.stories.update({
        where: { id: storyId },
        data: { viewsCount: newViewsCount },
      });

      // Notify story author for live view count update
      io.to(`user:${story.authorId}`).emit('story:viewed', {
        storyId,
        viewsCount: newViewsCount,
      });
    } catch (err) {
      console.error('story:view error:', err);
    }
  });

  // Location update
  socket.on('location:update', (data) => {
    const userId = getSocketUserId(socket);
    socket.broadcast.emit('user:location_changed', {
      userId: userId || socket.id,
      ...data,
    });
  });

  socket.on('disconnect', (reason) => {
    const userId = socketUsers.get(socket.id);

    agentRealtimeVoiceService.cleanupSocket(socket.id);
    
    if (userId) {
      // Remove from user sockets
      userSockets.get(userId)?.delete(socket.id);
      if (userSockets.get(userId)?.size === 0) {
        userSockets.delete(userId);
      }
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
const allowedOrigins = [...defaultAllowedOrigins, ...extraOrigins];
const generalApiRateLimit = createRateLimitMiddleware((req) => [
  {
    keyPrefix: 'rate:ip:api',
    limit: 120,
    windowSeconds: 60,
  },
  ...(req.user?.userId
    ? [
        {
          keyPrefix: 'rate:user:api',
          limit: 600,
          windowSeconds: 60,
        },
      ]
    : []),
]);

app.use(httpLogger);
app.use(metricsMiddleware);
app.use(helmet());
app.use(requestSizeGuard(5 * 1024 * 1024));
app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    // Allow local network IPs (e.g. 172.20.10.3:3000, 192.168.x.x:3000)
    if (/^https?:\/\/(172\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}):(3000|3001)$/.test(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

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

    res.status(200).json({
      status: 'ok',
      timestamp: Date.now(),
      database: 'connected',
      redis: isRedisEnabled() ? 'configured' : 'disabled',
    });
  } catch (error) {
    console.error('Readiness check failed:', error);
    res.status(503).json({
      status: 'error',
      timestamp: Date.now(),
      database: 'disconnected',
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
      database: 'connected',
    });
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(503).json({
      status: 'error',
      timestamp: Date.now(),
      database: 'disconnected',
      message: 'Database connection failed',
    });
  }
});

app.get('/metrics', async (_req: Request, res: Response): Promise<void> => {
  res.setHeader('Content-Type', register.contentType);
  res.status(200).send(await register.metrics());
});

// API Documentation (Swagger UI)
setupSwagger(app, PORT);
app.use('/api', generalApiRateLimit);

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
app.use('/api/groups', groupsRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/social-proof', socialProofRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/premium', premiumRoutes);
app.use('/api/badges', badgesRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/learning', learningRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/interviews', interviewsRoutes);
app.use('/api/challenges', challengesRoutes);
app.use('/api/ai/chat', aiChatRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/reels', reelsRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/daily-hooks', dailyHooksRoutes);

// 404 handler for undefined routes
app.use(notFoundHandler);

// Error handling middleware (must be last)
app.use(errorHandler);
const server = httpServer;

const handleStartupError = async (error: NodeJS.ErrnoException): Promise<void> => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Another process is already listening on http://localhost:${PORT}.`);
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

// Start server
server.listen(PORT, (): void => {
  server.removeListener('error', onStartupError);

  console.log(`
🚀 Server is running!
📍 Environment: ${process.env.NODE_ENV || 'development'}
🌐 Server URL: http://localhost:${PORT}
📊 Health Check: http://localhost:${PORT}/api/health
📚 API Docs: http://localhost:${PORT}/api-docs
🔌 WebSocket: ws://localhost:${PORT}
  `);
});

// Graceful shutdown
const gracefulShutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  server.close(async (): Promise<void> => {
    console.log('HTTP server closed.');

    try {
      await disconnectRedisClients();
      await Promise.allSettled(getAllQueues().map((queue) => queue.close()));
      await disconnectPrisma();
      console.log('Database connection closed.');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
