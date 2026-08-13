import axios from 'axios';
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { isThirdPartyHttpError } from '../utils/http-client-with-breaker.util';
import { verifyRazorpaySignature } from '../services/premium-checkout.service';
import {
  activatePremiumFromRazorpayPayment,
  createRazorpayOrder,
  fetchRazorpayOrder,
  fetchRazorpayPayment,
  getRazorpayWebhookSecret,
  invalidatePremiumEntitlementCaches,
  isRazorpayConfigured,
  readOrderUserId,
  verifyRazorpayWebhookSignature,
} from '../services/premium-razorpay.service';
import {
  buildPremiumPlanConfig,
  cancelPremiumSubscription,
  formatCurrency,
  getPremiumAccessSnapshot,
  getPremiumDurationDaysForBillingCycle,
  isCreatorProPlan,
  logPremiumCheckoutEvent,
  normalizePremiumCheckoutPlan,
  normalizePremiumBillingCycle,
  serializePremiumSubscription,
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
import {
  getCreatorProState,
  updateCreatorProSettings,
} from '../services/creator-pro.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

type WebhookRequest = Request & { rawBody?: Buffer };

type RazorpayWebhookPayload = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
    order?: { entity?: { id?: string } };
  };
};

type SafeRazorpayError = {
  statusCode: number;
  clientMessage: string;
  code: string;
  logMessage: string;
  metadata: { [key: string]: string | number | null };
};

function isPremiumCheckoutConfigured() {
  return isRazorpayConfigured() || isGooglePlayPremiumConfigured();
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

    const order = await createRazorpayOrder({
      amount: config.amountMinor,
      currency: config.currency,
      receipt,
      notes,
    });

    await logPremiumCheckoutEvent({
      userId,
      eventType: 'CHECKOUT_CREATED',
      outcome: 'success',
      message: 'Premium checkout order created successfully.',
      amountMinor: config.amountMinor,
      currency: config.currency,
      metadata: {
        provider: 'razorpay',
        orderId: order.id,
        receipt,
        plan: config.plan,
        billingCycle: config.billingCycle,
      },
    });

    res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      orderId: order.id,
      amountMinor: config.amountMinor,
      currency: config.currency,
      displayAmount: formatCurrency(config.amountMinor, config.currency),
      plan: config.plan,
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

    const [order, payment] = await Promise.all([
      fetchRazorpayOrder(razorpayOrderId),
      fetchRazorpayPayment(razorpayPaymentId),
    ]);

    const activation = await activatePremiumFromRazorpayPayment({
      userId,
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      order,
      payment,
      source: 'checkout',
    });

    if (activation.ok === false) {
      res.status(activation.statusCode).json({ error: activation.error });
      return;
    }

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);

    res.json({
      message: activation.alreadyActivated
        ? 'This payment was already applied to your account.'
        : 'Premium unlocked successfully.',
      alreadyActivated: activation.alreadyActivated,
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

/**
 * Razorpay webhook receiver. The browser verify call is best-effort — a user can pay and
 * then close the tab before it runs — so this is the authoritative path that still grants
 * premium for a captured payment. Configure the endpoint plus RAZORPAY_WEBHOOK_SECRET in
 * the Razorpay dashboard for `payment.captured` and `order.paid`.
 */
export const handleRazorpayWebhook = async (
  req: WebhookRequest,
  res: Response
): Promise<void> => {
  const webhookSecret = getRazorpayWebhookSecret();

  if (!webhookSecret || !isRazorpayConfigured()) {
    res.status(503).json({ error: 'Razorpay webhooks are not configured on this server.' });
    return;
  }

  const signature = req.header('x-razorpay-signature') || undefined;
  const rawBody = req.rawBody;

  if (!rawBody) {
    res.status(400).json({ error: 'Webhook body could not be read.' });
    return;
  }

  if (!verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn('Rejected a Razorpay webhook with an invalid signature.');
    res.status(400).json({ error: 'Invalid webhook signature.' });
    return;
  }

  // Read from the verified raw body rather than the parsed/sanitised copy: only the raw
  // bytes are covered by the signature we just checked.
  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookPayload;
  } catch {
    res.status(400).json({ error: 'Webhook body is not valid JSON.' });
    return;
  }

  const event = String(payload.event || '');
  const paymentEntity = payload.payload?.payment?.entity;
  const orderEntity = payload.payload?.order?.entity;
  const paymentId = String(paymentEntity?.id || '').trim();
  const orderId = String(paymentEntity?.order_id || orderEntity?.id || '').trim();

  // Acknowledge everything else so Razorpay stops retrying events we do not act on.
  if (!['payment.captured', 'order.paid'].includes(event) || !paymentId || !orderId) {
    res.status(200).json({ received: true, handled: false });
    return;
  }

  try {
    const [order, payment] = await Promise.all([
      fetchRazorpayOrder(orderId),
      fetchRazorpayPayment(paymentId),
    ]);

    const userId = readOrderUserId(order);
    if (!userId) {
      console.warn(`Razorpay webhook order ${orderId} has no userId note; skipping.`);
      res.status(200).json({ received: true, handled: false });
      return;
    }

    // A deleted account can never be activated, so answer 200 instead of letting the
    // downstream "user not found" throw turn into an endless Razorpay retry loop.
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!userExists) {
      console.warn(`Razorpay webhook order ${orderId} references a missing user; skipping.`);
      res.status(200).json({ received: true, handled: false });
      return;
    }

    const activation = await activatePremiumFromRazorpayPayment({
      userId,
      orderId,
      paymentId,
      order,
      payment,
      source: 'webhook',
    });

    if (activation.ok === false) {
      await logPremiumCheckoutEvent({
        userId,
        eventType: 'CHECKOUT_WEBHOOK',
        outcome: 'failure',
        message: `Razorpay webhook could not unlock premium: ${activation.error}`,
        metadata: { event, orderId, paymentId },
      });
      // 200 keeps Razorpay from retrying a payload we have permanently rejected.
      res.status(200).json({ received: true, handled: false });
      return;
    }

    res.status(200).json({
      received: true,
      handled: true,
      alreadyActivated: activation.alreadyActivated,
    });
  } catch (error) {
    const safeError = getSafeRazorpayError(error);
    console.error('Failed to process Razorpay webhook', safeError.logMessage, safeError.metadata);
    // 5xx asks Razorpay to retry, which is what we want for transient upstream failures.
    res.status(502).json({ error: 'Could not process the webhook right now.' });
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
