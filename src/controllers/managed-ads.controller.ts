import { Request, Response } from 'express';
import {
  recordManagedAdEvent,
  selectManagedAdSidebarPlacement,
  type ManagedAdEventType,
  type ManagedAdPlacementName,
} from '../services/managed-ad.service';

interface AuthRequest extends Request {
  user?: { userId: string; sessionId?: string };
}

const placements = new Set(['feed', 'reels', 'sidebar']);

function getPlacement(value: unknown): ManagedAdPlacementName {
  const placement = String(value || '').trim().toLowerCase();
  return placements.has(placement) ? placement as ManagedAdPlacementName : 'feed';
}

async function trackEvent(req: AuthRequest, res: Response, eventType: ManagedAdEventType): Promise<void> {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const campaignId = String(req.params.campaignId || '').trim();
    if (!campaignId) {
      res.status(400).json({ error: 'Campaign ID is required' });
      return;
    }

    await recordManagedAdEvent({
      campaignId,
      userId: String(req.user.userId),
      eventType,
      placement: getPlacement(req.body?.placement),
      slotKey: typeof req.body?.slotKey === 'string' ? req.body.slotKey.trim() : null,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : null,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error(`track managed ad ${eventType} error:`, error);
    res.status(500).json({ error: 'Failed to track ad event' });
  }
}

export const trackManagedAdImpression = (req: AuthRequest, res: Response): Promise<void> =>
  trackEvent(req, res, 'impression');

export const trackManagedAdClick = (req: AuthRequest, res: Response): Promise<void> =>
  trackEvent(req, res, 'click');

export const getSidebarManagedAd = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const ad = await selectManagedAdSidebarPlacement({
      userId: String(req.user.userId),
      sessionId: typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : null,
    });

    res.json({ ad });
  } catch (error) {
    console.error('get sidebar managed ad error:', error);
    res.status(500).json({ error: 'Failed to load sidebar ad' });
  }
};
