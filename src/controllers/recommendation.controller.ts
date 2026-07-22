import type { Request, Response } from 'express';
import {
  getRecommendationPreferences,
  ingestRecommendationEvents,
  updateRecommendationFeedback,
  updateRecommendationPreferences,
  recordAuthoritativeRecommendationOutcome,
} from '../services/recommendation-platform.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function userIdOrUnauthorized(req: AuthRequest, res: Response): string | null {
  const userId = req.user?.userId ? String(req.user.userId) : '';
  if (!userId) res.status(401).json({ error: 'Unauthorized' });
  return userId || null;
}

export async function ingestEvents(req: AuthRequest, res: Response): Promise<void> {
  const userId = userIdOrUnauthorized(req, res);
  if (!userId) return;
  try {
    const result = await ingestRecommendationEvents(userId, req.body?.events);
    res.status(202).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid recommendation events';
    res.status(message.includes('between 1 and 100') ? 400 : 500).json({ error: message });
  }
}

export async function submitFeedback(req: AuthRequest, res: Response): Promise<void> {
  const userId = userIdOrUnauthorized(req, res);
  if (!userId) return;
  try {
    const action = String(req.body?.action || '').toUpperCase();
    const entityType = String(req.body?.entityType || '').toUpperCase();
    const entityId = String(req.body?.entityId || '').trim();
    if (
      !['NOT_INTERESTED', 'HIDE_AUTHOR', 'UNDO'].includes(action) ||
      !['POST', 'REEL', 'STORY', 'PERSON', 'JOB', 'EVENT'].includes(entityType) ||
      !entityId || entityId.length > 128
    ) {
      res.status(400).json({ error: 'action, entityType, and entityId are required' });
      return;
    }
    const result = await updateRecommendationFeedback(userId, {
      action: action as any,
      entityType: entityType as any,
      entityId,
      authorId: req.body?.authorId ? String(req.body.authorId) : null,
      feedbackType: req.body?.feedbackType ? String(req.body.feedbackType).toUpperCase() as any : undefined,
    });
    if (result.active) {
      void recordAuthoritativeRecommendationOutcome({
        userId,
        entityType: entityType as any,
        entityId,
        eventType: 'NEGATIVE_FEEDBACK',
        meaningfulOutcome: false,
      }).catch(() => undefined);
    }
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update recommendation feedback';
    res.status(message.startsWith('Invalid') || message.includes('required') ? 400 : 500).json({ error: message });
  }
}

export async function getPreferences(req: AuthRequest, res: Response): Promise<void> {
  const userId = userIdOrUnauthorized(req, res);
  if (!userId) return;
  try {
    res.json(await getRecommendationPreferences(userId));
  } catch (error) {
    console.error('get recommendation preferences error:', error);
    res.status(500).json({ error: 'Failed to load recommendation preferences' });
  }
}

export async function patchPreferences(req: AuthRequest, res: Response): Promise<void> {
  const userId = userIdOrUnauthorized(req, res);
  if (!userId) return;
  try {
    const input: { personalizedRecommendationsEnabled?: boolean; activityRecommendationsEnabled?: boolean } = {};
    if (typeof req.body?.personalizedRecommendationsEnabled === 'boolean') {
      input.personalizedRecommendationsEnabled = req.body.personalizedRecommendationsEnabled;
    }
    if (typeof req.body?.activityRecommendationsEnabled === 'boolean') {
      input.activityRecommendationsEnabled = req.body.activityRecommendationsEnabled;
    }
    res.json(await updateRecommendationPreferences(userId, input));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update recommendation preferences';
    res.status(message.includes('required') ? 400 : 500).json({ error: message });
  }
}
