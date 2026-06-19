import { Response } from 'express';
import { getRequestId } from '../lib/logger';
import { getPremiumAccessSnapshot } from '../services/premium-access.service';
import { AuthenticatedRequest } from '../types/auth.types';

function getAITier(snapshot: Awaited<ReturnType<typeof getPremiumAccessSnapshot>>): string {
  if (snapshot.user.isAdmin) return 'admin';
  if (snapshot.isCreatorPro) return 'creator_pro';
  if (snapshot.isPremium) return 'premium';
  return 'free';
}

export const getAIEntitlements = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        code: 'unauthorized',
        requestId: getRequestId(req),
      });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    const tier = getAITier(snapshot);

    res.json({
      tier,
      isPremium: snapshot.isPremium || snapshot.isCreatorPro || snapshot.user.isAdmin,
      isCreatorPro: snapshot.isCreatorPro,
      isAdmin: snapshot.user.isAdmin,
      canUseAgent: snapshot.canUseAgent,
      canAccessProfileCustomization: snapshot.canAccessProfileCustomization,
      balance: 0,
      creditsUsed: snapshot.creditsUsed,
      agentPromptLimit: snapshot.agentPromptLimit,
      agentLimitReached: snapshot.agentLimitReached,
      premiumDisplayAmount: snapshot.premiumDisplayAmount,
      premiumEndsAt: snapshot.premiumEndsAt,
      dayPass: null,
    });
  } catch (error) {
    console.error('getAIEntitlements error:', error);
    res.status(500).json({
      error: 'Failed to load AI entitlements',
      code: 'ai_entitlements_failed',
      requestId: getRequestId(req),
    });
  }
};
