import { Response } from "express";
import { getPremiumAccessSnapshot, serializePremiumSubscription, logPremiumCheckoutEvent, cancelPremiumSubscription } from "../../services/premium-access.service";
import { getMyProfileBoostState, getPremiumEntitlements, activateProfileBoostForUser } from "../../services/premium-visibility.service";
import { FREE_CONNECTION_REQUESTS_PER_DAY } from "../../../safety/services/tier-limits.service";
import { getCreatorProState, updateCreatorProSettings } from "../../services/creator-pro.service";
import { invalidatePremiumEntitlementCaches } from "../../services/premium-razorpay.service";
import { AuthRequest, isPremiumCheckoutConfigured } from "./support.controller";

export const getPremiumSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    const [profileBoost] = await Promise.all([
      getMyProfileBoostState(userId),
    ]);
    res.json({
      ...serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
      entitlements: getPremiumEntitlements(FREE_CONNECTION_REQUESTS_PER_DAY),
      profileBoost,
    });
  } catch (error) {
    console.error('Failed to fetch premium subscription', error);
    res.status(500).json({ error: 'Failed to fetch premium subscription' });
  }
};

export const getCreatorProForMe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const [state, snapshot, profileBoost] = await Promise.all([
      getCreatorProState(userId),
      getPremiumAccessSnapshot(userId),
      getMyProfileBoostState(userId),
    ]);

    res.json({
      ...state,
      subscription: {
        ...serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
        entitlements: getPremiumEntitlements(FREE_CONNECTION_REQUESTS_PER_DAY),
        profileBoost,
      },
    });
  } catch (error) {
    console.error('Failed to fetch creator pro state', error);
    res.status(500).json({ error: 'Failed to fetch Creator Pro state' });
  }
};

export const updateCreatorProSettingsForMe = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await updateCreatorProSettings(userId, req.body || {});
    if (!result.ok) {
      res.status(result.statusCode).json({
        error: result.error,
        code: result.code,
      });
      return;
    }

    const [snapshot, profileBoost] = await Promise.all([
      getPremiumAccessSnapshot(userId),
      getMyProfileBoostState(userId),
    ]);

    res.json({
      ...result.state,
      subscription: {
        ...serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
        entitlements: getPremiumEntitlements(FREE_CONNECTION_REQUESTS_PER_DAY),
        profileBoost,
      },
    });
  } catch (error) {
    console.error('Failed to update creator pro settings', error);
    res.status(500).json({ error: 'Failed to update Creator Pro settings' });
  }
};

export const getMyProfileBoost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.json({
      profileBoost: await getMyProfileBoostState(userId),
    });
  } catch (error) {
    console.error('Failed to fetch profile boost state', error);
    res.status(500).json({ error: 'Failed to fetch profile boost state' });
  }
};

export const activateMyProfileBoost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const durationHours =
      typeof req.body?.durationHours === 'number' && Number.isFinite(req.body.durationHours)
        ? req.body.durationHours
        : undefined;
    const result = await activateProfileBoostForUser(userId, { durationHours });

    if (!result.ok) {
      res.status(result.statusCode).json({
        error: result.error,
        code: result.code,
      });
      return;
    }

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'PROFILE_BOOST_ACTIVATED',
      outcome: 'success',
      message: 'Profile boost activated.',
      metadata: {
        endsAt: result.boost.endsAt,
        durationHours: result.boost.durationHours,
        priority: result.boost.priority,
      },
    });

    invalidatePremiumEntitlementCaches(userId, 'profile boost');

    const [snapshot, profileBoost] = await Promise.all([
      getPremiumAccessSnapshot(userId),
      getMyProfileBoostState(userId),
    ]);
    res.status(201).json({
      message: 'Profile boost is live.',
      profileBoost,
      boost: result.boost,
      subscription: {
        ...serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
        entitlements: getPremiumEntitlements(FREE_CONNECTION_REQUESTS_PER_DAY),
        profileBoost,
      },
    });
  } catch (error) {
    console.error('Failed to activate profile boost', error);
    res.status(500).json({ error: 'Failed to activate profile boost' });
  }
};

export const cancelMyPremiumSubscription = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    if (!snapshot.subscription || !snapshot.canCancelPremium) {
      res.status(409).json({
        error: 'There is no active premium plan to cancel on this account.',
        subscription: serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
      });
      return;
    }

    await cancelPremiumSubscription(userId, 'user');
    await logPremiumCheckoutEvent({
      userId,
      eventType: 'SUBSCRIPTION_CANCELLED',
      outcome: 'success',
      message: 'User cancelled premium access.',
      amountMinor: snapshot.premiumAmountMinor,
      currency: snapshot.premiumCurrency,
    });
    invalidatePremiumEntitlementCaches(userId, 'premium cancellation');

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);
    res.json({
      message: 'Premium cancelled. You can buy it again anytime.',
      subscription: serializePremiumSubscription(updatedSnapshot, isPremiumCheckoutConfigured()),
    });
  } catch (error) {
    console.error('Failed to cancel premium subscription', error);
    res.status(500).json({ error: 'Failed to cancel premium subscription' });
  }
};
