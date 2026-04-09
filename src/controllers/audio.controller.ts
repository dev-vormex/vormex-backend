// @ts-nocheck
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function mapAudioResponse(audio: any, currentUserId?: string) {
  const isSaved = currentUserId
    ? Boolean((audio as any).saves?.some((s: any) => s.userId === currentUserId))
    : false;

  return {
    id: audio.id,
    title: audio.title,
    artist: audio.artist,
    albumName: audio.albumName,
    albumArt: audio.albumArt,
    audioUrl: audio.audioUrl,
    durationMs: audio.durationMs,
    genre: audio.genre,
    mood: audio.mood,
    tempo: audio.tempo,
    isRoyaltyFree: audio.isRoyaltyFree,
    source: audio.source,
    licenseType: audio.licenseType,
    attribution: audio.attribution,
    isOriginal: audio.isOriginal,
    originalCreatorId: audio.originalCreatorId,
    usageCount: audio.usageCount,
    savesCount: audio.savesCount,
    isSaved,
    createdAt: audio.createdAt,
  };
}

const audioInclude = (currentUserId?: string) => ({
  ...(currentUserId
    ? {
        saves: { where: { userId: currentUserId }, select: { userId: true } },
      }
    : {}),
});

export const getTrendingAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '20', 10), 1), 50);

    const audio = await prisma.reel_audio.findMany({
      where: { isActive: true },
      include: audioInclude(currentUserId),
      orderBy: [{ usageCount: 'desc' }, { savesCount: 'desc' }],
      take: limit,
    });

    res.json({
      audio: audio.map((a) => mapAudioResponse(a, currentUserId)),
    });
  } catch (error) {
    console.error('getTrendingAudio error:', error);
    res.status(500).json({ error: 'Failed to fetch trending audio' });
  }
};

export const searchAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const query = (req.query.q as string) || '';
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '20', 10), 1), 50);
    const cursor = req.query.cursor as string | undefined;

    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const audio = await prisma.reel_audio.findMany({
      where: {
        isActive: true,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { artist: { contains: query, mode: 'insensitive' } },
          { albumName: { contains: query, mode: 'insensitive' } },
          { genre: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: audioInclude(currentUserId),
      orderBy: [{ usageCount: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = audio.length > limit;
    const pageItems = hasMore ? audio.slice(0, limit) : audio;

    res.json({
      audio: pageItems.map((a) => mapAudioResponse(a, currentUserId)),
      nextCursor: hasMore ? pageItems[pageItems.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    console.error('searchAudio error:', error);
    res.status(500).json({ error: 'Failed to search audio' });
  }
};

export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const genres = await prisma.reel_audio.groupBy({
      by: ['genre'],
      where: { isActive: true, genre: { not: null } },
      _count: true,
      orderBy: { _count: { genre: 'desc' } },
    });

    res.json({
      categories: genres
        .filter((g) => g.genre)
        .map((g) => ({
          name: g.genre,
          count: g._count,
        })),
    });
  } catch (error) {
    console.error('getCategories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

export const getMoods = async (_req: Request, res: Response): Promise<void> => {
  try {
    const moods = await prisma.reel_audio.groupBy({
      by: ['mood'],
      where: { isActive: true, mood: { not: null } },
      _count: true,
      orderBy: { _count: { mood: 'desc' } },
    });

    res.json({
      moods: moods
        .filter((m) => m.mood)
        .map((m) => ({
          name: m.mood,
          count: m._count,
        })),
    });
  } catch (error) {
    console.error('getMoods error:', error);
    res.status(500).json({ error: 'Failed to fetch moods' });
  }
};

export const getAudioByGenre = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const genre = ensureString(req.params.genre);
    if (!genre) {
      res.status(400).json({ error: 'Genre required' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);
    const cursor = ensureString(req.query.cursor);

    const audio = await prisma.reel_audio.findMany({
      where: {
        isActive: true,
        genre: { equals: genre, mode: 'insensitive' },
      },
      include: audioInclude(currentUserId),
      orderBy: [{ usageCount: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = audio.length > limit;
    const pageItems = hasMore ? audio.slice(0, limit) : audio;

    res.json({
      genre,
      audio: pageItems.map((a) => mapAudioResponse(a, currentUserId)),
      nextCursor: hasMore ? pageItems[pageItems.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    console.error('getAudioByGenre error:', error);
    res.status(500).json({ error: 'Failed to fetch audio by genre' });
  }
};

export const getAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const audioId = ensureString(req.params.audioId);
    if (!audioId) {
      res.status(400).json({ error: 'Audio ID required' });
      return;
    }

    const audio = await prisma.reel_audio.findUnique({
      where: { id: audioId },
      include: audioInclude(currentUserId),
    });

    if (!audio || !audio.isActive) {
      res.status(404).json({ error: 'Audio not found' });
      return;
    }

    res.json(mapAudioResponse(audio, currentUserId));
  } catch (error) {
    console.error('getAudio error:', error);
    res.status(500).json({ error: 'Failed to fetch audio' });
  }
};

export const getAudioReels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const audioId = ensureString(req.params.audioId);
    if (!audioId) {
      res.status(400).json({ error: 'Audio ID required' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(ensureString(req.query.limit) || '20', 10), 1), 50);
    const cursor = ensureString(req.query.cursor);

    const audio = await prisma.reel_audio.findUnique({
      where: { id: audioId },
      select: { id: true, title: true, artist: true, albumArt: true, usageCount: true },
    });

    if (!audio) {
      res.status(404).json({ error: 'Audio not found' });
      return;
    }

    const reels = await prisma.reels.findMany({
      where: {
        audioId: audioId,
        status: 'ready',
        visibility: 'public',
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
          },
        },
      },
      orderBy: [{ viewsCount: 'desc' }, { createdAt: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = reels.length > limit;
    const pageItems = hasMore ? reels.slice(0, limit) : reels;

    res.json({
      audio: {
        id: audio.id,
        title: audio.title,
        artist: audio.artist,
        albumArt: audio.albumArt,
        usageCount: audio.usageCount,
      },
      reels: pageItems.map((r) => ({
        id: r.id,
        author: r.author,
        thumbnailUrl: r.thumbnailUrl,
        viewsCount: r.viewsCount,
        likesCount: r.likesCount,
      })),
      nextCursor: hasMore ? pageItems[pageItems.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    console.error('getAudioReels error:', error);
    res.status(500).json({ error: 'Failed to fetch reels for audio' });
  }
};

export const toggleSaveAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const audioId = ensureString(req.params.audioId);
    if (!audioId) {
      res.status(400).json({ error: 'Audio ID required' });
      return;
    }

    const audio = await prisma.reel_audio.findUnique({
      where: { id: audioId },
      select: { id: true },
    });

    if (!audio) {
      res.status(404).json({ error: 'Audio not found' });
      return;
    }

    const existingSave = await prisma.reel_audio_saves.findUnique({
      where: { audioId_userId: { audioId, userId } },
    });

    let saved = false;
    if (existingSave) {
      await prisma.reel_audio_saves.delete({
        where: { audioId_userId: { audioId, userId } },
      });
    } else {
      await prisma.reel_audio_saves.create({
        data: { audioId, userId },
      });
      saved = true;
    }

    const savesCount = await prisma.reel_audio_saves.count({ where: { audioId } });
    await prisma.reel_audio.update({
      where: { id: audioId },
      data: { savesCount },
    });

    res.json({ saved, savesCount });
  } catch (error) {
    console.error('toggleSaveAudio error:', error);
    res.status(500).json({ error: 'Failed to toggle save' });
  }
};

export const getSavedAudio = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = req.user.userId;
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '20', 10), 1), 50);
    const cursor = req.query.cursor as string | undefined;

    const saves = await prisma.reel_audio_saves.findMany({
      where: { userId },
      include: {
        audio: {
          include: audioInclude(userId),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = saves.length > limit;
    const pageItems = hasMore ? saves.slice(0, limit) : saves;

    res.json({
      audio: pageItems
        .filter((s) => s.audio.isActive)
        .map((s) => mapAudioResponse(s.audio, userId)),
      nextCursor: hasMore ? pageItems[pageItems.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    console.error('getSavedAudio error:', error);
    res.status(500).json({ error: 'Failed to fetch saved audio' });
  }
};
