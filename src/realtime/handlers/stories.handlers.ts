import type { SocketHandlerInput } from '../types';
import { prisma } from '../../config/prisma';
import { canViewStory } from '../../shared/utils/access-control.util';

export function registerStoriesSocketHandlers({ io, socket, context }: SocketHandlerInput): void {
  const { getSocketUserId } = context;

  // ============================================
  // OTHER EVENTS
  // ============================================

  // Story view - record view and notify story author for live view count
  socket.on('story:view', async ({ storyId }: { storyId: string; duration?: number }) => {
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
}
