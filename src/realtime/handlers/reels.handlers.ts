import type { SocketHandlerInput } from '../types';
import { toggleReelLikeWithFanout, createReelCommentWithFanout } from '../content-fanout';
import { prisma } from '../../config/prisma';
import { canViewReel } from '../../shared/utils/access-control.util';

export function registerReelsSocketHandlers({ socket, context }: SocketHandlerInput): void {
  const { getSocketUserId } = context;

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
}
