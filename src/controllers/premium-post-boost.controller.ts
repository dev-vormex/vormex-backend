import type { Request, Response } from 'express';
import {
  cancelPostBoostCampaign,
  createPostBoostCampaign,
  getPostBoostCampaign,
  getPostBoostCredits,
  listMyPostBoostCampaigns,
} from '../services/premium-post-boost.service';

interface AuthRequest extends Request { user?: { userId: string } }

function statusForError(message: string): number {
  if (message === 'PREMIUM_REQUIRED') return 403;
  if (message === 'CAMPAIGN_NOT_FOUND') return 404;
  if (['POST_NOT_ELIGIBLE', 'NO_BOOST_CREDITS', 'ACTIVE_BOOST_EXISTS', 'CAMPAIGN_NOT_ACTIVE', 'POST_BOOST_DISABLED'].includes(message)) return 409;
  return 500;
}

async function handle(res: Response, operation: () => Promise<unknown>): Promise<void> {
  try { res.json(await operation()); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Post boost failed';
    res.status(statusForError(message)).json({ error: message });
  }
}

export async function getMyPostBoostCredits(req: AuthRequest, res: Response): Promise<void> {
  await handle(res, () => getPostBoostCredits(String(req.user!.userId)));
}

export async function createMyPostBoost(req: AuthRequest, res: Response): Promise<void> {
  const postId = String(req.body?.postId || '').trim();
  if (!postId) { res.status(400).json({ error: 'postId is required' }); return; }
  await handle(res, () => createPostBoostCampaign(String(req.user!.userId), postId));
}

export async function listMyPostBoosts(req: AuthRequest, res: Response): Promise<void> {
  await handle(res, async () => ({ campaigns: await listMyPostBoostCampaigns(String(req.user!.userId)) }));
}

export async function getMyPostBoost(req: AuthRequest, res: Response): Promise<void> {
  await handle(res, () => getPostBoostCampaign(String(req.user!.userId), String(req.params.campaignId)));
}

export async function cancelMyPostBoost(req: AuthRequest, res: Response): Promise<void> {
  await handle(res, () => cancelPostBoostCampaign(String(req.user!.userId), String(req.params.campaignId)));
}
