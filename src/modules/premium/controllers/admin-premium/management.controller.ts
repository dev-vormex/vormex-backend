import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { getPremiumAccessSnapshot, cancelPremiumSubscription, logPremiumCheckoutEvent } from "../../services/premium-access.service";
import { AuthRequest, parsePositiveInt } from "./support.controller";

export const updatePremiumAdminUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.params.id || '');
    if (!userId) {
      res.status(400).json({ error: 'User id is required' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hasExplicitPremiumOverride =
      req.body?.premiumPriceOverrideMinor !== undefined &&
      req.body?.premiumPriceOverrideMinor !== null &&
      String(req.body?.premiumPriceOverrideMinor).trim() !== '';
    const premiumPriceOverrideMinor = hasExplicitPremiumOverride
      ? parsePositiveInt(req.body?.premiumPriceOverrideMinor, 0)
      : null;
    const agentEnabled = Boolean(req.body?.agentEnabled);
    const agentBlocked = Boolean(req.body?.agentBlocked);
    const profileCustomizationGranted = Boolean(req.body?.profileCustomizationGranted);
    const profileCustomizationBlocked = Boolean(req.body?.profileCustomizationBlocked);

    if (
      !hasExplicitPremiumOverride &&
      !agentEnabled &&
      !agentBlocked &&
      !profileCustomizationGranted &&
      !profileCustomizationBlocked
    ) {
      await prisma.user_feature_access_overrides.deleteMany({
        where: { userId },
      });
    } else {
      await prisma.user_feature_access_overrides.upsert({
        where: { userId },
        update: {
          premiumPriceOverrideMinor:
            hasExplicitPremiumOverride && premiumPriceOverrideMinor !== null && premiumPriceOverrideMinor > 0
              ? premiumPriceOverrideMinor
              : null,
          agentEnabled,
          agentBlocked,
          profileCustomizationGranted,
          profileCustomizationBlocked,
        },
        create: {
          userId,
          premiumPriceOverrideMinor:
            hasExplicitPremiumOverride && premiumPriceOverrideMinor !== null && premiumPriceOverrideMinor > 0
              ? premiumPriceOverrideMinor
              : null,
          agentEnabled,
          agentBlocked,
          profileCustomizationGranted,
          profileCustomizationBlocked,
        },
      });
    }

    const snapshot = await getPremiumAccessSnapshot(userId);

    res.json({
      message: 'Premium user access updated successfully',
      user: {
        id: userId,
        premiumPriceOverrideMinor: snapshot.override?.premiumPriceOverrideMinor ?? null,
        agentEnabled: Boolean(snapshot.override?.agentEnabled),
        agentBlocked: Boolean(snapshot.override?.agentBlocked),
        profileCustomizationGranted: Boolean(snapshot.override?.profileCustomizationGranted),
        profileCustomizationBlocked: Boolean(snapshot.override?.profileCustomizationBlocked),
        canUseAgent: snapshot.canUseAgent,
        canAccessProfileCustomization: snapshot.canAccessProfileCustomization,
        premiumDisplayAmount: snapshot.premiumDisplayAmount,
      },
    });
  } catch (error) {
    console.error('updatePremiumAdminUser error:', error);
    res.status(500).json({ error: 'Failed to update premium user access' });
  }
};

export const cancelPremiumAdminUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.params.id || '');
    if (!userId) {
      res.status(400).json({ error: 'User id is required' });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    if (!snapshot.subscription || !snapshot.isPremium) {
      res.status(409).json({ error: 'This user does not have an active premium plan.' });
      return;
    }

    await cancelPremiumSubscription(userId, 'admin');
    await prisma.user_feature_access_overrides.upsert({
      where: { userId },
      update: {
        premiumPriceOverrideMinor: null,
        agentEnabled: false,
        agentBlocked: true,
        profileCustomizationGranted: false,
        profileCustomizationBlocked: true,
      },
      create: {
        userId,
        premiumPriceOverrideMinor: null,
        agentEnabled: false,
        agentBlocked: true,
        profileCustomizationGranted: false,
        profileCustomizationBlocked: true,
      },
    });
    await logPremiumCheckoutEvent({
      userId,
      eventType: 'ADMIN_CANCELLED_SUBSCRIPTION',
      outcome: 'success',
      message: `Premium access revoked by admin ${req.user.userId}.`,
      amountMinor: snapshot.premiumAmountMinor,
      currency: snapshot.premiumCurrency,
      metadata: {
        adminUserId: req.user.userId,
      },
    });

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);
    res.json({
      message: 'Premium access cancelled for this user.',
      user: {
        id: userId,
        isPremium: updatedSnapshot.isPremium,
        premiumStatus: updatedSnapshot.subscription?.status || 'inactive',
        premiumEndsAt: updatedSnapshot.premiumEndsAt,
        premiumDaysRemaining: updatedSnapshot.premiumDaysRemaining,
        canUseAgent: updatedSnapshot.canUseAgent,
        canAccessProfileCustomization: updatedSnapshot.canAccessProfileCustomization,
      },
    });
  } catch (error) {
    console.error('cancelPremiumAdminUser error:', error);
    res.status(500).json({ error: 'Failed to cancel premium access for this user' });
  }
};
