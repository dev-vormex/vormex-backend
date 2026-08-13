import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { requestWithBreaker } from '../utils/http-client-with-breaker.util';
import {
  type PremiumPlanConfig,
  type RazorpayOrderEntity,
  type RazorpayPaymentEntity,
  validatePremiumCheckoutPayment,
  verifyRazorpayWebhookSignature as verifyWebhookSignature,
} from './premium-checkout.service';
import {
  getPremiumDurationDaysForBillingCycle,
  getPremiumPeriodEnd,
  getPremiumPlan,
  logPremiumCheckoutEvent,
  normalizePremiumBillingCycle,
  getPremiumAccessSnapshot,
} from './premium-access.service';
import { cacheService } from './cache.service';

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';
const RAZORPAY_TIMEOUTS = { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 };

export type RazorpayActivationSource = 'checkout' | 'webhook';

export type RazorpayActivationResult =
  | {
      ok: true;
      alreadyActivated: boolean;
      subscriptionId: string;
      plan: string;
      amountMinor: number;
      currency: string;
    }
  | { ok: false; statusCode: number; error: string };

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function getRazorpayWebhookSecret(): string | undefined {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return secret ? secret : undefined;
}

export function getRazorpayAuth(): { username: string; password: string } {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured on the server.');
  }

  return {
    username: process.env.RAZORPAY_KEY_ID,
    password: process.env.RAZORPAY_KEY_SECRET,
  };
}

export async function createRazorpayOrder(data: {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrderEntity> {
  const response = await requestWithBreaker<RazorpayOrderEntity>(
    'razorpay',
    'create_order',
    {
      method: 'POST',
      url: `${RAZORPAY_API_BASE}/orders`,
      data,
      auth: getRazorpayAuth(),
    },
    RAZORPAY_TIMEOUTS
  );
  return response.data;
}

export async function fetchRazorpayOrder(orderId: string): Promise<RazorpayOrderEntity> {
  const response = await requestWithBreaker<RazorpayOrderEntity>(
    'razorpay',
    'fetch_order',
    {
      method: 'GET',
      url: `${RAZORPAY_API_BASE}/orders/${orderId}`,
      auth: getRazorpayAuth(),
    },
    RAZORPAY_TIMEOUTS
  );
  return response.data;
}

export async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPaymentEntity> {
  const response = await requestWithBreaker<RazorpayPaymentEntity>(
    'razorpay',
    'fetch_payment',
    {
      method: 'GET',
      url: `${RAZORPAY_API_BASE}/payments/${paymentId}`,
      auth: getRazorpayAuth(),
    },
    RAZORPAY_TIMEOUTS
  );
  return response.data;
}

export function verifyRazorpayWebhookSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret = getRazorpayWebhookSecret()
): boolean {
  return verifyWebhookSignature(rawBody, signature, secret);
}

function readNote(notes: Record<string, unknown> | undefined, key: string): string | null {
  const value = notes?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readOrderUserId(order: RazorpayOrderEntity): string | null {
  return readNote(order.notes, 'userId');
}

function buildPlanConfigFromOrder(
  order: RazorpayOrderEntity,
  fallbackAmountMinor: number,
  fallbackCurrency: string
): PremiumPlanConfig {
  const notedAmountMinor = Number(order.notes?.amountMinor || order.amount || fallbackAmountMinor);

  return {
    amountMinor:
      Number.isFinite(notedAmountMinor) && notedAmountMinor > 0
        ? Math.round(notedAmountMinor)
        : fallbackAmountMinor,
    currency: String(order.notes?.currency || order.currency || fallbackCurrency).toUpperCase(),
    plan: String(order.notes?.plan || getPremiumPlan()),
    billingCycle: normalizePremiumBillingCycle(String(order.notes?.billingCycle || 'monthly')),
  };
}

type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * A Razorpay payment id can reach us several times — the browser verify call, the
 * `payment.captured` webhook, the `order.paid` webhook, plus retries of any of them — so
 * the verified-checkout event doubles as the idempotency key: the same payment must never
 * extend the subscription period or be counted as revenue twice.
 */
async function findExistingActivation(
  client: PrismaTransactionClient | typeof prisma,
  userId: string,
  paymentId: string
) {
  return client.premium_checkout_events.findFirst({
    where: {
      userId,
      eventType: 'CHECKOUT_VERIFIED',
      metadata: {
        path: ['paymentId'],
        equals: paymentId,
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, amountMinor: true, currency: true },
  });
}

export function invalidatePremiumEntitlementCaches(userId: string, label: string): void {
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

/**
 * Turns a captured Razorpay payment into premium access. Shared by the browser verify
 * endpoint and the webhook so both paths apply identical validation and idempotency.
 */
export async function activatePremiumFromRazorpayPayment(input: {
  userId: string;
  orderId: string;
  paymentId: string;
  order: RazorpayOrderEntity;
  payment: RazorpayPaymentEntity;
  source: RazorpayActivationSource;
}): Promise<RazorpayActivationResult> {
  const { userId, orderId, paymentId, order, payment, source } = input;

  const snapshot = await getPremiumAccessSnapshot(userId);
  const config = buildPlanConfigFromOrder(
    order,
    snapshot.premiumAmountMinor,
    snapshot.premiumCurrency
  );

  const validation = validatePremiumCheckoutPayment({
    userId,
    expectedOrderId: orderId,
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
        source,
        orderId,
        paymentId,
      },
    });
    return { ok: false, statusCode: validation.statusCode, error: validation.error };
  }

  const now = new Date();
  const durationDays =
    Number(order.notes?.durationDays) ||
    getPremiumDurationDaysForBillingCycle(config.billingCycle);
  const currentPeriodEnd = getPremiumPeriodEnd(now, durationDays);
  const providerFields = {
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
  };

  // The verify call and both webhook events can land at the same instant for one payment.
  // A per-user advisory lock makes the "already applied?" check and the write atomic, so a
  // single payment can never extend the period twice or be counted as revenue twice.
  const activation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

    const existingActivation = await findExistingActivation(tx, userId, paymentId);
    if (existingActivation) {
      const existingSubscription = await tx.subscriptions.findUnique({
        where: { userId },
        select: { id: true, plan: true, amount: true, currency: true },
      });

      return {
        alreadyActivated: true as const,
        subscriptionId: existingSubscription?.id || '',
        plan: existingSubscription?.plan || getPremiumPlan(),
        amountMinor: existingSubscription?.amount ?? existingActivation.amountMinor ?? 0,
        currency: existingSubscription?.currency || existingActivation.currency || 'INR',
      };
    }

    const subscription = await tx.subscriptions.upsert({
      where: { userId },
      create: {
        id: randomUUID(),
        userId,
        ...providerFields,
      },
      update: providerFields,
    });

    await tx.user_feature_access_overrides.updateMany({
      where: { userId },
      data: {
        agentBlocked: false,
        profileCustomizationBlocked: false,
      },
    });

    await tx.premium_checkout_events.create({
      data: {
        userId,
        eventType: 'CHECKOUT_VERIFIED',
        outcome: 'success',
        message:
          source === 'webhook'
            ? 'Premium unlocked from a Razorpay webhook payment.'
            : 'Premium unlocked successfully.',
        amountMinor: config.amountMinor,
        currency: config.currency,
        metadata: {
          source,
          provider: 'razorpay',
          orderId,
          paymentId,
          plan: config.plan,
          billingCycle: config.billingCycle,
          subscriptionId: subscription.id,
          paymentMethod: typeof payment.method === 'string' ? payment.method : null,
          periodEnd: currentPeriodEnd.toISOString(),
        },
      },
    });

    return {
      alreadyActivated: false as const,
      subscriptionId: subscription.id,
      plan: config.plan,
      amountMinor: config.amountMinor,
      currency: config.currency,
    };
  });

  if (!activation.alreadyActivated) {
    invalidatePremiumEntitlementCaches(userId, `razorpay ${source}`);
  }

  return { ok: true, ...activation };
}
