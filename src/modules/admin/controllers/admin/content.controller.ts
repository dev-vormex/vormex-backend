import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { AuthRequest } from "./support.controller";

// ============================================
// POSTS
// ============================================

export const getPosts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const type = req.query.type as string;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.content = { contains: search, mode: 'insensitive' };
    }
    if (type && type !== 'all') {
      where.type = type;
    }

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          content: true,
          mediaUrls: true,
          likesCount: true,
          commentsCount: true,
          createdAt: true,
          author: {
            select: {
              id: true,
              name: true,
              username: true,
              profileImage: true,
            },
          },
        },
      }),
      prisma.post.count({ where }),
    ]);

    res.json({
      posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getPosts error:', error);
    res.status(500).json({ error: 'Failed to load posts' });
  }
};

export const deletePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.post.delete({ where: { id: req.params.id } });

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('deletePost error:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
};

// ============================================
// REELS
// ============================================

export const getReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [reels, total] = await Promise.all([
      prisma.reels.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          videoUrl: true,
          thumbnailUrl: true,
          caption: true,
          viewsCount: true,
          likesCount: true,
          commentsCount: true,
          createdAt: true,
          users: {
            select: {
              id: true,
              name: true,
              username: true,
              profileImage: true,
            },
          },
        },
      }),
      prisma.reels.count(),
    ]);

    const mappedReels = reels.map((r) => ({
      ...r,
      author: r.users,
      users: undefined,
    }));

    res.json({
      reels: mappedReels,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getReels error:', error);
    res.status(500).json({ error: 'Failed to load reels' });
  }
};

export const deleteReel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await prisma.reels.delete({ where: { id: req.params.id } });

    res.json({ message: 'Reel deleted successfully' });
  } catch (error) {
    console.error('deleteReel error:', error);
    res.status(500).json({ error: 'Failed to delete reel' });
  }
};
