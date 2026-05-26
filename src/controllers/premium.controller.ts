import { randomUUID } from 'crypto';
import axios from 'axios';
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import {
  type PremiumPlanConfig,
  type RazorpayOrderEntity,
  type RazorpayPaymentEntity,
  validatePremiumCheckoutPayment,
  verifyRazorpaySignature,
} from '../services/premium-checkout.service';
import {
  buildPremiumPlanConfig,
  cancelPremiumSubscription,
  getPremiumAccessSnapshot,
  getPremiumDurationDaysForBillingCycle,
  getPremiumPlan,
  getPremiumPeriodEnd,
  isDeveloperPremiumOverrideAvailableForUser,
  logPremiumCheckoutEvent,
  normalizePremiumBillingCycle,
  serializePremiumSubscription,
  setDeveloperPremiumOverride,
} from '../services/premium-access.service';
import {
  GooglePlayPremiumVerificationError,
  isGooglePlayPremiumConfigured,
  verifyGooglePlayPremiumPurchase,
} from '../services/google-play-premium.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function isRazorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function isPremiumCheckoutConfigured() {
  return isRazorpayConfigured() || isGooglePlayPremiumConfigured();
}

function getRazorpayAuth() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured on the server.');
  }

  return {
    username: process.env.RAZORPAY_KEY_ID,
    password: process.env.RAZORPAY_KEY_SECRET,
  };
}

async function fetchRazorpayOrder(orderId: string) {
  const response = await axios.get<RazorpayOrderEntity>(
    `https://api.razorpay.com/v1/orders/${orderId}`,
    { auth: getRazorpayAuth() }
  );
  return response.data;
}

async function fetchRazorpayPayment(paymentId: string) {
  const response = await axios.get<RazorpayPaymentEntity>(
    `https://api.razorpay.com/v1/payments/${paymentId}`,
    { auth: getRazorpayAuth() }
  );
  return response.data;
}

export const getPremiumSubscription = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    res.json(serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()));
  } catch (error) {
    console.error('Failed to fetch premium subscription', error);
    res.status(500).json({ error: 'Failed to fetch premium subscription' });
  }
};

export const setDeveloperPremiumOverrideForMe = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentSnapshot = await getPremiumAccessSnapshot(userId);
    if (!isDeveloperPremiumOverrideAvailableForUser(currentSnapshot.user)) {
      res.status(403).json({
        error: 'Developer premium override is not enabled on this server.',
        code: 'developer_premium_override_disabled',
      });
      return;
    }

    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({
        error: 'enabled must be a boolean.',
        code: 'developer_premium_override_invalid_payload',
      });
      return;
    }

    await setDeveloperPremiumOverride(userId, req.body.enabled);
    await logPremiumCheckoutEvent({
      userId,
      eventType: 'DEVELOPER_PREMIUM_OVERRIDE_UPDATED',
      outcome: 'success',
      message: req.body.enabled
        ? 'Developer premium override enabled.'
        : 'Developer premium override disabled.',
      metadata: {
        enabled: req.body.enabled,
      },
    });

    const snapshot = await getPremiumAccessSnapshot(userId);
    res.json({
      message: snapshot.isPremium
        ? 'Premium mode is on for this account.'
        : 'Premium mode is off for this account.',
      subscription: serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
    });
  } catch (error) {
    console.error('Failed to update developer premium override', error);
    res.status(500).json({ error: 'Failed to update premium mode' });
  }
};

export const createPremiumCheckout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'CLICKED_GET_PREMIUM',
      outcome: 'info',
      message: 'User clicked the Get Premium button.',
    });

    if (!isRazorpayConfigured()) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: 'Premium checkout is not configured on the server yet.',
      });
      res.status(503).json({ error: 'Premium checkout is not configured on the server yet.' });
      return;
    }

    const [snapshot, user] = await Promise.all([
      getPremiumAccessSnapshot(userId),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
        },
      }),
    ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (snapshot.isPremium) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: 'Premium is already active for this account.',
        amountMinor: snapshot.premiumAmountMinor,
        currency: snapshot.premiumCurrency,
      });
      res.status(409).json({
        error: 'Premium is already active for this account.',
        subscription: serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
      });
      return;
    }

    const requestedBillingCycle = normalizePremiumBillingCycle(req.body?.billingCycle);
    const config = buildPremiumPlanConfig(snapshot, requestedBillingCycle);
    const durationDays = getPremiumDurationDaysForBillingCycle(config.billingCycle);
    const receipt = `premium_${userId.slice(0, 8)}_${Date.now().toString(36)}`.slice(0, 40);
    const notes = {
      userId,
      plan: config.plan,
      billingCycle: config.billingCycle,
      amountMinor: String(config.amountMinor),
      currency: config.currency,
      durationDays: String(durationDays),
    };

    const orderResponse = await axios.post<RazorpayOrderEntity>(
      'https://api.razorpay.com/v1/orders',
      {
        amount: config.amountMinor,
        currency: config.currency,
        receipt,
        notes,
      },
      {
        auth: getRazorpayAuth(),
      }
    );

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'CHECKOUT_CREATED',
      outcome: 'success',
      message: 'Premium checkout order created successfully.',
      amountMinor: config.amountMinor,
      currency: config.currency,
      metadata: {
        orderId: orderResponse.data.id,
        receipt,
        billingCycle: config.billingCycle,
      },
    });

    res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: orderResponse.data.id,
      amountMinor: config.amountMinor,
      currency: config.currency,
      displayAmount: snapshot.premiumDisplayAmount,
      title: config.title,
      description: config.description,
      billingCycle: config.billingCycle,
      premiumDurationDays: durationDays,
      prefill: {
        name: user.name,
        email: user.email,
      },
      features: config.features,
    });
  } catch (error) {
    console.error('Failed to create premium checkout', error);
    if (req.user?.userId) {
      await logPremiumCheckoutEvent({
        userId: req.user.userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: error instanceof Error ? error.message : 'Failed to create premium checkout',
      });
    }
    res.status(500).json({ error: 'Failed to create premium checkout' });
  }
};

export const verifyPremiumCheckout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const body = req.body as {
      razorpayOrderId?: string;
      razorpayPaymentId?: string;
      razorpaySignature?: string;
    };

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const razorpayOrderId = body.razorpayOrderId?.trim();
    const razorpayPaymentId = body.razorpayPaymentId?.trim();
    const razorpaySignature = body.razorpaySignature?.trim();

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: 'Missing payment verification details.',
      });
      res.status(400).json({ error: 'Missing payment verification details.' });
      return;
    }

    if (!isRazorpayConfigured()) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: 'Premium checkout is not configured on the server yet.',
      });
      res.status(503).json({ error: 'Premium checkout is not configured on the server yet.' });
      return;
    }

    if (
      !verifyRazorpaySignature(
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        process.env.RAZORPAY_KEY_SECRET
      )
    ) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: 'Payment signature verification failed.',
      });
      res.status(400).json({ error: 'Payment signature verification failed.' });
      return;
    }

    const snapshot = await getPremiumAccessSnapshot(userId);
    const [order, payment] = await Promise.all([
      fetchRazorpayOrder(razorpayOrderId),
      fetchRazorpayPayment(razorpayPaymentId),
    ]);

    const configuredAmountMinor = Number(order.notes?.amountMinor || order.amount || snapshot.premiumAmountMinor);
    const config: PremiumPlanConfig = {
      amountMinor:
        Number.isFinite(configuredAmountMinor) && configuredAmountMinor > 0
          ? Math.round(configuredAmountMinor)
          : snapshot.premiumAmountMinor,
      currency: String(order.notes?.currency || order.currency || snapshot.premiumCurrency).toUpperCase(),
      plan: String(order.notes?.plan || getPremiumPlan()),
      billingCycle: normalizePremiumBillingCycle(String(order.notes?.billingCycle || 'monthly')),
    };

    const validation = validatePremiumCheckoutPayment({
      userId,
      expectedOrderId: razorpayOrderId,
      order,
      payment,
      config,
    });

    if (validation.ok === false) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: validation.error,
        amountMinor: config.amountMinor,
        currency: config.currency,
        metadata: {
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
        },
      });
      res.status(validation.statusCode).json({ error: validation.error });
      return;
    }

    const now = new Date();
    const durationDays = Number(order.notes?.durationDays) || getPremiumDurationDaysForBillingCycle(config.billingCycle);
    const currentPeriodEnd = getPremiumPeriodEnd(now, durationDays);

    const subscription = await prisma.subscriptions.upsert({
      where: { userId },
      create: {
        id: randomUUID(),
        userId,
        plan: config.plan,
        status: validation.subscriptionStatus,
        amount: config.amountMinor,
        currency: config.currency,
        billingCycle: config.billingCycle,
        provider: 'razorpay',
        currentPeriodStart: now,
        currentPeriodEnd,
        cancelledAt: null,
        trialEndsAt: null,
        razorpaySubscriptionId: null,
        razorpayCustomerId: null,
        razorpayPlanId: null,
        googlePlayPurchaseToken: null,
        googlePlayOrderId: null,
        googlePlayProductId: null,
        googlePlayBasePlanId: null,
        googlePlaySubscriptionState: null,
        googlePlayAcknowledgementState: null,
        lastProviderSyncAt: now,
      },
      update: {
        plan: config.plan,
        status: validation.subscriptionStatus,
        amount: config.amountMinor,
        currency: config.currency,
        billingCycle: config.billingCycle,
        provider: 'razorpay',
        currentPeriodStart: now,
        currentPeriodEnd,
        cancelledAt: null,
        trialEndsAt: null,
        razorpaySubscriptionId: null,
        razorpayCustomerId: null,
        razorpayPlanId: null,
        googlePlayPurchaseToken: null,
        googlePlayOrderId: null,
        googlePlayProductId: null,
        googlePlayBasePlanId: null,
        googlePlaySubscriptionState: null,
        googlePlayAcknowledgementState: null,
        lastProviderSyncAt: now,
      },
    });

    await prisma.user_feature_access_overrides.updateMany({
      where: { userId },
      data: {
        agentBlocked: false,
        profileCustomizationBlocked: false,
      },
    });

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'CHECKOUT_VERIFIED',
      outcome: 'success',
      message: 'Premium unlocked successfully.',
      amountMinor: config.amountMinor,
      currency: config.currency,
      metadata: {
        orderId: razorpayOrderId,
        paymentId: razorpayPaymentId,
        subscriptionId: subscription.id,
      },
    });

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);

    res.json({
      message: 'Premium unlocked successfully.',
      subscription: serializePremiumSubscription(updatedSnapshot, isPremiumCheckoutConfigured()),
    });
  } catch (error) {
    console.error('Failed to verify premium checkout', error);
    if (req.user?.userId) {
      await logPremiumCheckoutEvent({
        userId: req.user.userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: error instanceof Error ? error.message : 'Failed to verify premium checkout',
      });
    }
    res.status(500).json({ error: 'Failed to verify premium checkout' });
  }
};

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
