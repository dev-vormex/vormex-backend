import { Response } from "express";
import { logPremiumCheckoutEvent } from "../../services/premium-access.service";
import { verifyGooglePlayPremiumPurchase, GooglePlayPremiumVerificationError } from "../../services/google-play-premium.service";
import { invalidatePremiumEntitlementCaches } from "../../services/premium-razorpay.service";
import { AuthRequest } from "./support.controller";

export const verifyGooglePlayPremiumCheckout = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  const userId = req.user?.userId;

  try {
    const body = req.body as {
      productId?: string;
      purchaseToken?: string;
    };

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const productId = body.productId?.trim();
    const purchaseToken = body.purchaseToken?.trim();

    if (!productId || !purchaseToken) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: 'Missing Google Play purchase verification details.',
        metadata: {
          provider: 'google_play',
        },
      });
      res.status(400).json({
        error: 'Missing Google Play purchase verification details.',
        code: 'google_play_details_missing',
      });
      return;
    }

    const result = await verifyGooglePlayPremiumPurchase({
      userId,
      productId,
      purchaseToken,
    });
    invalidatePremiumEntitlementCaches(userId, 'google play premium checkout');
    res.json(result);
  } catch (error) {
    console.error('Failed to verify Google Play premium checkout', error);
    if (userId) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: error instanceof Error ? error.message : 'Failed to verify Google Play purchase',
        metadata:
          error instanceof GooglePlayPremiumVerificationError
            ? { provider: 'google_play', code: error.code }
            : { provider: 'google_play' },
      });
    }
    const statusCode =
      error instanceof GooglePlayPremiumVerificationError ? error.statusCode : 500;
    res.status(statusCode).json({
      error:
        error instanceof Error
          ? error.message
          : 'Failed to verify Google Play purchase',
      code:
        error instanceof GooglePlayPremiumVerificationError
          ? error.code
          : 'google_play_verification_failed',
    });
  }
};
