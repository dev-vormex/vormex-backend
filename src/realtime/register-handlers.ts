import type { SocketContext } from './context';
import { registerAgentSocketHandlers } from './handlers/agent.handlers';
import { registerPostsSocketHandlers } from './handlers/posts.handlers';
import { registerChatSocketHandlers } from './handlers/chat.handlers';
import { registerGroupsSocketHandlers } from './handlers/groups.handlers';
import { registerReelsSocketHandlers } from './handlers/reels.handlers';
import { registerStoriesSocketHandlers } from './handlers/stories.handlers';
import { registerLocationSocketHandlers } from './handlers/location.handlers';
import { Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/prisma';
import { logger } from '../infrastructure/logging/logger';
import { containsPromptInjection, sanitizeInputTree } from '../shared/utils/input-security.util';
import { agentRealtimeVoiceService } from '../modules/agent/services/realtime-voice.service';
import { verifySocketAccessToken } from '../shared/middleware/auth.middleware';
import { registerArcadeSocketHandlers } from './handlers/arcade.handlers';

export function registerSocketHandlers(io: SocketIOServer, context: SocketContext): void {
  const {
    userSockets,
    socketUsers,
    socketLocationUpdateTimestamps,
    registerSharedChatPresence,
    startChatPresenceRefresh,
    unregisterSharedChatPresence,
    groupOnlineCounts,
    getSocketUserId,
    joinCoarseNearbyRoomIfAllowed,
    emitPresenceToAuthorizedRooms,
    getSocketHandshakeToken,
    emitChatPresence,
    markPendingMessagesDelivered,
  } = context;
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
          (event.startsWith('agent:') || event.includes('message') || event.includes('comment')) &&
          typeof result.value === 'object' &&
          result.value !== null &&
          JSON.stringify(result.value).length <= 10_000 &&
          containsPromptInjection(JSON.stringify(result.value))
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
        prisma.user
          .update({
            where: { id: userId },
            data: { isOnline: true, lastActiveAt: new Date() },
          })
          .catch((error) => {
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
    registerAgentSocketHandlers({ io, socket, context });

    registerPostsSocketHandlers({ io, socket, context });

    registerChatSocketHandlers({ io, socket, context });

    registerGroupsSocketHandlers({ io, socket, context });

    registerReelsSocketHandlers({ io, socket, context });

    registerStoriesSocketHandlers({ io, socket, context });

    registerLocationSocketHandlers({ io, socket, context });

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
          prisma.user
            .update({
              where: { id: userId },
              data: { isOnline: false, lastActiveAt: new Date() },
            })
            .catch((error) => {
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
}
