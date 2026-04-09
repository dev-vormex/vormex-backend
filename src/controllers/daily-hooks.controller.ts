import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';

interface DailyHook {
  id: string;
  type: string;
  title: string;
  action: { label: string; href: string };
  emoji: string;
  priority: number;
  data?: Record<string, unknown>;
}

/**
 * GET /api/daily-hooks
 * Returns contextual action prompts (hooks) for the authenticated user
 */
export const getHooks = async (
  req: AuthenticatedRequest,
  res: Response<{ hooks: DailyHook[]; date: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = String(req.user.userId);

    const [user, connectionCount, postCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          bio: true,
          profileImage: true,
          onboardingCompleted: true,
        },
      }),
      prisma.connections.count({
        where: {
          OR: [{ requesterId: userId }, { addresseeId: userId }],
          status: 'accepted',
        },
      }),
      prisma.post.count({ where: { authorId: userId } }),
    ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hooks: DailyHook[] = [];
    let priority = 1;

    // Onboarding incomplete
    if (!user.onboardingCompleted) {
      hooks.push({
        id: 'complete-onboarding',
        type: 'onboarding',
        title: 'Complete your onboarding to get personalized matches',
        action: { label: 'Complete', href: '/onboarding' },
        emoji: '✨',
        priority: priority++,
      });
    }

    // Profile incomplete - no bio
    if (!user.bio || user.bio.trim().length < 20) {
      hooks.push({
        id: 'add-bio',
        type: 'profile',
        title: 'Add a bio to help others discover you',
        action: { label: 'Add Bio', href: '/profile/edit' },
        emoji: '📝',
        priority: priority++,
      });
    }

    // No profile picture
    if (!user.profileImage) {
      hooks.push({
        id: 'add-avatar',
        type: 'profile',
        title: 'Add a profile picture to stand out',
        action: { label: 'Add Photo', href: '/profile/edit' },
        emoji: '📷',
        priority: priority++,
      });
    }

    // Few connections
    if (connectionCount < 5) {
      hooks.push({
        id: 'make-connections',
        type: 'engagement',
        title: 'Grow your network – connect with professionals in your field',
        action: { label: 'Find People', href: '/find-people' },
        emoji: '🤝',
        priority: priority++,
      });
    }

    // No posts yet
    if (postCount === 0) {
      hooks.push({
        id: 'create-first-post',
        type: 'engagement',
        title: 'Share your first post and start the conversation',
        action: { label: 'Create Post', href: '/feed' },
        emoji: '💬',
        priority: priority++,
      });
    }

    // General engagement hook (if user is fairly set up)
    if (connectionCount >= 3 && postCount >= 1 && user.bio && user.profileImage) {
      hooks.push({
        id: 'stay-active',
        type: 'engagement',
        title: 'Stay active – check your feed and connect with someone today',
        action: { label: 'View Feed', href: '/feed' },
        emoji: '🔥',
        priority: priority++,
      });
    }

    const date = new Date().toISOString().split('T')[0];

    res.status(200).json({ hooks, date });
  } catch (error) {
    console.error('Get daily hooks error:', error);
    res.status(500).json({ error: 'Failed to fetch daily hooks' });
  }
};
