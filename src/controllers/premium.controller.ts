import { randomUUID } from 'crypto';
import axios from 'axios';
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import {
  isThirdPartyHttpError,
  requestWithBreaker,
} from '../utils/http-client-with-breaker.util';
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
  formatCurrency,
  getCreatorProPlan,
  getPremiumAccessSnapshot,
  getPremiumDurationDaysForBillingCycle,
  getPremiumPlan,
  getPremiumPeriodEnd,
  isDeveloperPremiumOverrideAvailableForUser,
  isCreatorProPlan,
  logPremiumCheckoutEvent,
  normalizePremiumCheckoutPlan,
  normalizePremiumBillingCycle,
  serializePremiumSubscription,
  setDeveloperPremiumOverride,
} from '../services/premium-access.service';
import {
  activateProfileBoostForUser,
  getMyProfileBoostState,
  getPremiumEntitlements,
} from '../services/premium-visibility.service';
import {
  GooglePlayPremiumVerificationError,
  isGooglePlayPremiumConfigured,
  verifyGooglePlayPremiumPurchase,
} from '../services/google-play-premium.service';
import { FREE_CONNECTION_REQUESTS_PER_DAY } from '../services/tier-limits.service';
import { cacheService } from '../services/cache.service';
import {
  getCreatorProState,
  updateCreatorProSettings,
} from '../services/creator-pro.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

function invalidatePremiumEntitlementCaches(userId: string, label: string): void {
  cacheService
    .invalidateTags(
      'people:global',
      'matching:global',
      'feed:global',
      `people:user:${userId}`,
      `matching:user:${userId}`,
      `chat:user:${userId}`,
      `feed:${userId}`,
      `user:${userId}`
    )
    .catch((error) => console.error(`${label} cache invalidation failed:`, error));
}

type SafeRazorpayError = {
  statusCode: number;
  clientMessage: string;
  code: string;
  logMessage: string;
  metadata: { [key: string]: string | number | null };
};

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

function getRazorpayResponseError(error: unknown) {
  if (!axios.isAxiosError(error)) {
    return null;
  }

  const responseError =
    error.response?.data &&
    typeof error.response.data === 'object' &&
    'error' in error.response.data
      ? (error.response.data as { error?: unknown }).error
      : null;

  if (!responseError || typeof responseError !== 'object') {
    return null;
  }

  return responseError as {
    code?: unknown;
    description?: unknown;
    reason?: unknown;
    source?: unknown;
    step?: unknown;
  };
}

function getSafeRazorpayError(error: unknown): SafeRazorpayError {
  if (isThirdPartyHttpError(error)) {
    return {
      statusCode: 503,
      clientMessage:
        error.code === 'third_party_circuit_open'
          ? 'Razorpay checkout is temporarily unavailable. Please try again shortly.'
          : 'Could not reach Razorpay checkout. Please try again shortly.',
      code:
        error.code === 'third_party_circuit_open'
          ? 'razorpay_circuit_open'
          : 'razorpay_timeout',
      logMessage: error.message,
      metadata: {
        provider: error.provider,
        operation: error.operation,
        retryable: error.retryable ? 1 : 0,
      },
    };
  }

  if (!axios.isAxiosError(error)) {
    return {
      statusCode: 500,
      clientMessage: 'Failed to create premium checkout',
      code: 'premium_checkout_failed',
      logMessage: error instanceof Error ? error.message : 'Unknown checkout error',
      metadata: {},
    };
  }

  const providerError = getRazorpayResponseError(error);
  const providerCode =
    typeof providerError?.code === 'string' ? providerError.code : undefined;
  const providerReason =
    typeof providerError?.reason === 'string' ? providerError.reason : undefined;
  const providerDescription =
    typeof providerError?.description === 'string'
      ? providerError.description
      : undefined;
  const providerSource =
    typeof providerError?.source === 'string' ? providerError.source : undefined;
  const providerStep =
    typeof providerError?.step === 'string' ? providerError.step : undefined;
  const providerStatus = error.response?.status;
  const metadata = {
    provider: 'razorpay',
    providerStatus: providerStatus ?? null,
    providerCode: providerCode ?? null,
    providerReason: providerReason ?? null,
    providerSource: providerSource ?? null,
    providerStep: providerStep ?? null,
    axiosCode: error.code ?? null,
  };

  if (providerStatus === 401) {
    return {
      statusCode: 503,
      clientMessage:
        'Premium checkout is not configured correctly on the server. Please check Razorpay credentials and restart the backend.',
      code: 'razorpay_auth_failed',
      logMessage: 'Razorpay rejected the configured checkout credentials.',
      metadata,
    };
  }

  if (providerStatus === 400) {
    return {
      statusCode: 502,
      clientMessage:
        providerDescription || 'Razorpay rejected the premium checkout request.',
      code: 'razorpay_checkout_rejected',
      logMessage: providerDescription || 'Razorpay rejected the checkout request.',
      metadata,
    };
  }

  if (providerStatus === 429) {
    return {
      statusCode: 503,
      clientMessage: 'Razorpay is rate-limiting checkout right now. Please try again shortly.',
      code: 'razorpay_rate_limited',
      logMessage: 'Razorpay rate-limited premium checkout creation.',
      metadata,
    };
  }

  if (!error.response) {
    return {
      statusCode: 503,
      clientMessage: 'Could not reach Razorpay checkout. Please try again shortly.',
      code: 'razorpay_unreachable',
      logMessage: error.message || 'Razorpay checkout request failed without a response.',
      metadata,
    };
  }

  return {
    statusCode: 502,
    clientMessage: 'Razorpay checkout is temporarily unavailable. Please try again shortly.',
    code: 'razorpay_checkout_failed',
    logMessage: providerDescription || `Razorpay checkout failed with status ${providerStatus}.`,
    metadata,
  };
}

async function fetchRazorpayOrder(orderId: string) {
  const response = await requestWithBreaker<RazorpayOrderEntity>('razorpay', 'fetch_order', {
    method: 'GET',
    url: `https://api.razorpay.com/v1/orders/${orderId}`,
    auth: getRazorpayAuth(),
  }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });
  return response.data;
}

async function fetchRazorpayPayment(paymentId: string) {
  const response = await requestWithBreaker<RazorpayPaymentEntity>('razorpay', 'fetch_payment', {
    method: 'GET',
    url: `https://api.razorpay.com/v1/payments/${paymentId}`,
    auth: getRazorpayAuth(),
  }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });
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

    cacheService
      .invalidateTags(
        'people:global',
        'matching:global',
        'feed:global',
        `people:user:${userId}`,
        `matching:user:${userId}`,
        `feed:${userId}`,
        `user:${userId}`
      )
      .catch((error) => console.error('profile boost cache invalidation failed:', error));

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
    invalidatePremiumEntitlementCaches(userId, 'premium override');

    const [snapshot, profileBoost] = await Promise.all([
      getPremiumAccessSnapshot(userId),
      getMyProfileBoostState(userId),
    ]);
    res.json({
      message: snapshot.isPremium
        ? 'Premium mode is on for this account.'
        : 'Premium mode is off for this account.',
      subscription: {
        ...serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
        entitlements: getPremiumEntitlements(FREE_CONNECTION_REQUESTS_PER_DAY),
        profileBoost,
      },
    });
  } catch (error) {
    console.error('Failed to update developer premium override', error);
    res.status(500).json({ error: 'Failed to update premium mode' });
  }
};

export const setDeveloperCreatorProOverrideForMe = async (
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
        error: 'Developer Creator Pro override is not enabled on this server.',
        code: 'developer_creator_pro_override_disabled',
      });
      return;
    }

    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({
        error: 'enabled must be a boolean.',
        code: 'developer_creator_pro_override_invalid_payload',
      });
      return;
    }

    await setDeveloperPremiumOverride(userId, req.body.enabled, getCreatorProPlan());
    await logPremiumCheckoutEvent({
      userId,
      eventType: 'DEVELOPER_CREATOR_PRO_OVERRIDE_UPDATED',
      outcome: 'success',
      message: req.body.enabled
        ? 'Developer Creator Pro override enabled.'
        : 'Developer Creator Pro override disabled.',
      metadata: {
        enabled: req.body.enabled,
      },
    });

    cacheService
      .invalidateTags(
        'people:global',
        'matching:global',
        'feed:global',
        `people:user:${userId}`,
        `matching:user:${userId}`,
        `feed:${userId}`,
        `user:${userId}`
      )
      .catch((error) => console.error('creator pro override cache invalidation failed:', error));

    const [snapshot, profileBoost, creatorProState] = await Promise.all([
      getPremiumAccessSnapshot(userId),
      getMyProfileBoostState(userId),
      getCreatorProState(userId),
    ]);
    res.json({
      message: snapshot.isCreatorPro
        ? 'Creator Pro mode is on for this account.'
        : 'Creator Pro mode is off for this account.',
      ...creatorProState,
      subscription: {
        ...serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
        entitlements: getPremiumEntitlements(FREE_CONNECTION_REQUESTS_PER_DAY),
        profileBoost,
      },
    });
  } catch (error) {
    console.error('Failed to update developer Creator Pro override', error);
    res.status(500).json({ error: 'Failed to update Creator Pro mode' });
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

    const requestedPlan = normalizePremiumCheckoutPlan(req.body?.plan);
    const isCreatorProCheckout = isCreatorProPlan(requestedPlan);

    if (snapshot.isPremium && (!isCreatorProCheckout || snapshot.isCreatorPro)) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_BLOCKED',
        outcome: 'failure',
        message: isCreatorProCheckout
          ? 'Creator Pro is already active for this account.'
          : 'Premium is already active for this account.',
        amountMinor: snapshot.premiumAmountMinor,
        currency: snapshot.premiumCurrency,
      });
      res.status(409).json({
        error: isCreatorProCheckout
          ? 'Creator Pro is already active for this account.'
          : 'Premium is already active for this account.',
        subscription: serializePremiumSubscription(snapshot, isPremiumCheckoutConfigured()),
      });
      return;
    }

    const requestedBillingCycle = normalizePremiumBillingCycle(req.body?.billingCycle);
    const config = buildPremiumPlanConfig(snapshot, requestedBillingCycle, requestedPlan);
    const durationDays = getPremiumDurationDaysForBillingCycle(config.billingCycle);
    const receiptPrefix = isCreatorProCheckout ? 'creator' : 'premium';
    const receipt = `${receiptPrefix}_${userId.slice(0, 8)}_${Date.now().toString(36)}`.slice(0, 40);
    const notes = {
      userId,
      plan: config.plan,
      billingCycle: config.billingCycle,
      amountMinor: String(config.amountMinor),
      currency: config.currency,
      durationDays: String(durationDays),
    };

    const orderResponse = await requestWithBreaker<RazorpayOrderEntity>('razorpay', 'create_order', {
      method: 'POST',
      url: 'https://api.razorpay.com/v1/orders',
      data: {
        amount: config.amountMinor,
        currency: config.currency,
        receipt,
        notes,
      },
      auth: getRazorpayAuth(),
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

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
      displayAmount: formatCurrency(config.amountMinor, config.currency),
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
    const safeError = getSafeRazorpayError(error);
    console.error('Failed to create premium checkout', safeError.logMessage, safeError.metadata);
    if (req.user?.userId) {
      await logPremiumCheckoutEvent({
        userId: req.user.userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message: safeError.logMessage,
        metadata: safeError.metadata,
      });
    }
    res.status(safeError.statusCode).json({
      error: safeError.clientMessage,
      code: safeError.code,
    });
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
    invalidatePremiumEntitlementCaches(userId, 'premium checkout');

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);

    res.json({
      message: 'Premium unlocked successfully.',
      subscription: serializePremiumSubscription(updatedSnapshot, isPremiumCheckoutConfigured()),
    });
  } catch (error) {
    const safeError = getSafeRazorpayError(error);
    console.error('Failed to verify premium checkout', safeError.logMessage, safeError.metadata);
    if (req.user?.userId) {
      await logPremiumCheckoutEvent({
        userId: req.user.userId,
        eventType: 'CHECKOUT_FAILED',
        outcome: 'failure',
        message:
          safeError.code === 'premium_checkout_failed'
            ? 'Failed to verify premium checkout'
            : safeError.logMessage,
        metadata: safeError.metadata,
      });
    }
    res.status(safeError.statusCode).json({
      error:
        safeError.code === 'premium_checkout_failed'
          ? 'Failed to verify premium checkout'
          : safeError.clientMessage,
      code:
        safeError.code === 'premium_checkout_failed'
          ? 'premium_verification_failed'
          : safeError.code,
    });
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
