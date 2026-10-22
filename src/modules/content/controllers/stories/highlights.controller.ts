import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { ensureString } from "../../../../shared/utils/request.util";
import { AuthRequest } from "./support.controller";

// Create highlight
export const createHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { name, coverImage, storyIds } = req.body;
    const requestedStoryIds = Array.isArray(storyIds) ? storyIds.map(String).filter(Boolean) : [];
    if (requestedStoryIds.length > 0) {
      const ownedStories = await prisma.stories.count({
        where: { id: { in: requestedStoryIds }, authorId: userId },
      });
      if (ownedStories !== new Set(requestedStoryIds).size) {
        res.status(403).json({ error: 'Highlights can only include your own stories' });
        return;
      }
    }
    res.json({ message: 'Highlight created', highlight: { id: 'temp', name, coverImage, storyIds } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create highlight' });
  }
};

// Get user highlights
export const getUserHighlights = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ highlights: [] });
};

// Get highlight stories
export const getHighlightStories = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ highlight: null });
};

// Update highlight
export const updateHighlight = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ message: 'Highlight updated', highlight: null });
};

// Delete highlight
export const deleteHighlight = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ message: 'Highlight deleted' });
};

// Add story to highlight
export const addStoryToHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const storyId = ensureString(req.params.storyId);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!storyId) {
    res.status(400).json({ error: 'Story ID is required' });
    return;
  }
  const story = await prisma.stories.findFirst({ where: { id: storyId, authorId: userId }, select: { id: true } });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ message: 'Story added to highlight' });
};

// Remove story from highlight
export const removeStoryFromHighlight = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.userId;
  const storyId = ensureString(req.params.storyId);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!storyId) {
    res.status(400).json({ error: 'Story ID is required' });
    return;
  }
  const story = await prisma.stories.findFirst({ where: { id: storyId, authorId: userId }, select: { id: true } });
  if (!story) {
    res.status(404).json({ error: 'Story not found' });
    return;
  }
  res.json({ message: 'Story removed from highlight' });
};
