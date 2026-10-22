import type { SocketHandlerInput } from '../types';
import { feedRealtimeRoom, togglePostReactionWithFanout, createPostCommentWithFanout, toggleCommentLikeWithFanout, votePollWithFanout } from '../content-fanout';
import { prisma } from '../../config/prisma';
import { canViewPost } from '../../shared/utils/access-control.util';
import { emitRealtimeEnvelopes } from '../../infrastructure/realtime/emitter';
import { safetyErrorResponse } from '../../modules/safety/services/trust-safety.service';

export function registerPostsSocketHandlers({ socket, context }: SocketHandlerInput): void {
  const { getSocketUserId } = context;

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
      emitRealtimeEnvelopes(result.realtimeEnvelopes);
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
      emitRealtimeEnvelopes(result.realtimeEnvelopes);
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
      const safety = safetyErrorResponse(error);
      if (safety) {
        socket.emit('error', safety.body);
        return;
      }
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
      const safety = safetyErrorResponse(error);
      if (safety) {
        socket.emit('error', safety.body);
        return;
      }
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
}
