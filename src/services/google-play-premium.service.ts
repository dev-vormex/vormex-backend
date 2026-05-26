import { createHash, randomUUID } from 'crypto';
import { GoogleAuth } from 'google-auth-library';
import { prisma } from '../config/prisma';
import {
  buildPremiumPlanConfig,
  getPremiumAccessSnapshot,
  getPremiumPlan,
  logPremiumCheckoutEvent,
  serializePremiumSubscription,
} from './premium-access.service';

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_PACKAGE_NAME = 'com.vormex.android';
const DEFAULT_PREMIUM_PRODUCT_ID = 'vormex_premium';
const DEFAULT_MONTHLY_BASE_PLAN_ID = 'premium-monthly-prepaid';
const DEFAULT_YEARLY_BASE_PLAN_ID = 'premium-yearly-prepaid';

type GoogleAuthClient = Awaited<ReturnType<GoogleAuth['getClient']>>;

export type GooglePlayBillingCycle = 'monthly' | 'yearly';

export interface GooglePlayPremiumConfig {
  packageName: string;
  productId: string;
  monthlyBasePlanId: string;
  yearlyBasePlanId: string;
}

export interface GooglePlaySubscriptionLineItem {
  productId?: string;
  expiryTime?: string;
  latestSuccessfulOrderId?: string;
  latest_successful_order_id?: string;
  offerDetails?: {
    basePlanId?: string;
    base_plan_id?: string;
    offerId?: string;
    offerTags?: string[];
  };
}

export interface GooglePlaySubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  lineItems?: GooglePlaySubscriptionLineItem[];
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  externalAccountIdentifiers?: {
    externalAccountId?: string;
    obfuscatedExternalAccountId?: string;
    obfuscatedExternalProfileId?: string;
  };
  testPurchase?: Record<string, never>;
}

export type GooglePlayPremiumValidationResult =
  | {
      ok: true;
      billingCycle: GooglePlayBillingCycle;
      basePlanId: string;
      productId: string;
      orderId: string | null;
      subscriptionState: string;
      acknowledgementState: string;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      linkedPurchaseToken: string | null;
    }
  | {
      ok: false;
      statusCode: number;
      code: string;
      error: string;
    };

type GooglePlayServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
};

let authClientPromise: Promise<GoogleAuthClient> | null = null;

export class GooglePlayPremiumVerificationError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = 'google_play_verification_failed') {
    super(message);
    this.name = 'GooglePlayPremiumVerificationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function readEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function getGooglePlayPremiumConfig(): GooglePlayPremiumConfig {
  return {
    packageName: readEnv('GOOGLE_PLAY_PACKAGE_NAME', DEFAULT_PACKAGE_NAME),
    productId: readEnv('GOOGLE_PLAY_PREMIUM_PRODUCT_ID', DEFAULT_PREMIUM_PRODUCT_ID),
    monthlyBasePlanId: readEnv(
      'GOOGLE_PLAY_PREMIUM_MONTHLY_BASE_PLAN_ID',
      DEFAULT_MONTHLY_BASE_PLAN_ID
    ),
    yearlyBasePlanId: readEnv(
      'GOOGLE_PLAY_PREMIUM_YEARLY_BASE_PLAN_ID',
      DEFAULT_YEARLY_BASE_PLAN_ID
    ),
  };
}

export function isGooglePlayPremiumConfigured() {
  return Boolean(
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64?.trim() ||
      process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim()
  );
}

export function getGooglePlayObfuscatedAccountId(userId: string) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

function parseServiceAccountCredentials(): GooglePlayServiceAccountCredentials {
  const encoded = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  const raw = encoded
    ? Buffer.from(encoded, 'base64').toString('utf8')
    : process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim();

  if (!raw) {
    throw new GooglePlayPremiumVerificationError(
      'Google Play verification is not configured on the server yet.',
      503,
      'google_play_not_configured'
    );
  }

  try {
    const credentials = JSON.parse(raw.replace(/\\n/g, '\n')) as GooglePlayServiceAccountCredentials;
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('Missing service account client_email or private_key.');
    }
    return credentials;
  } catch (error) {
    throw new GooglePlayPremiumVerificationError(
      error instanceof Error
        ? `Invalid Google Play service account credentials: ${error.message}`
        : 'Invalid Google Play service account credentials.',
      503,
      'google_play_credentials_invalid'
    );
  }
}

async function getAndroidPublisherClient() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({
      credentials: parseServiceAccountCredentials(),
      scopes: [ANDROID_PUBLISHER_SCOPE],
    });
    authClientPromise = auth.getClient();
  }

  return authClientPromise;
}

function encodePathPart(value: string) {
  return encodeURIComponent(value);
}

async function fetchGooglePlaySubscriptionPurchase(
  purchaseToken: string,
  config: GooglePlayPremiumConfig
) {
  const client = await getAndroidPublisherClient();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodePathPart(config.packageName)}/purchases/subscriptionsv2/tokens/` +
    encodePathPart(purchaseToken);
  const response = await client.request<GooglePlaySubscriptionPurchaseV2>({
    url,
    method: 'GET',
  });
  return response.data;
}

async function acknowledgeGooglePlaySubscriptionPurchase(
  purchaseToken: string,
  config: GooglePlayPremiumConfig
) {
  const client = await getAndroidPublisherClient();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodePathPart(config.packageName)}/purchases/subscriptions/` +
    `${encodePathPart(config.productId)}/tokens/${encodePathPart(purchaseToken)}:acknowledge`;
  await client.request({
    url,
    method: 'POST',
    data: {},
  });
}

function normalizeState(value: string | undefined | null) {
  return String(value || '').trim().toUpperCase();
}

function readBasePlanId(lineItem: GooglePlaySubscriptionLineItem) {
  return lineItem.offerDetails?.basePlanId || lineItem.offerDetails?.base_plan_id || null;
}

function readOrderId(
  purchase: GooglePlaySubscriptionPurchaseV2,
  lineItem: GooglePlaySubscriptionLineItem
) {
  return lineItem.latestSuccessfulOrderId || lineItem.latest_successful_order_id || purchase.latestOrderId || null;
}

function resolveBillingCycle(
  basePlanId: string | null,
  config: GooglePlayPremiumConfig
): GooglePlayBillingCycle | null {
  if (basePlanId === config.monthlyBasePlanId) {
    return 'monthly';
  }
  if (basePlanId === config.yearlyBasePlanId) {
    return 'yearly';
  }
  return null;
}

export function validateGooglePlayPremiumPurchase(input: {
  userId: string;
  requestedProductId: string;
  purchaseToken: string;
  purchase: GooglePlaySubscriptionPurchaseV2;
  config?: GooglePlayPremiumConfig;
  now?: Date;
}): GooglePlayPremiumValidationResult {
  const config = input.config || getGooglePlayPremiumConfig();
  const now = input.now || new Date();
  const requestedProductId = input.requestedProductId.trim();
  const purchaseToken = input.purchaseToken.trim();

  if (!purchaseToken) {
    return {
      ok: false,
      statusCode: 400,
      code: 'google_play_purchase_token_missing',
      error: 'Missing Google Play purchase token.',
    };
  }

  if (requestedProductId !== config.productId) {
    return {
      ok: false,
      statusCode: 400,
      code: 'google_play_product_mismatch',
      error: 'Google Play product does not match Vormex Premium.',
    };
  }

  const lineItem = input.purchase.lineItems?.find((item) => item.productId === config.productId);
  if (!lineItem) {
    return {
      ok: false,
      statusCode: 400,
      code: 'google_play_product_not_found',
      error: 'Google Play purchase does not include the Vormex Premium product.',
    };
  }

  const basePlanId = readBasePlanId(lineItem);
  const billingCycle = resolveBillingCycle(basePlanId, config);
  if (!basePlanId || !billingCycle) {
    return {
      ok: false,
      statusCode: 400,
      code: 'google_play_base_plan_mismatch',
      error: 'Google Play base plan does not match a supported Vormex Premium plan.',
    };
  }

  const subscriptionState = normalizeState(input.purchase.subscriptionState);
  const allowedStates = new Set([
    'SUBSCRIPTION_STATE_ACTIVE',
    'SUBSCRIPTION_STATE_CANCELED',
    'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  ]);
  if (!allowedStates.has(subscriptionState)) {
    return {
      ok: false,
      statusCode: 409,
      code: 'google_play_subscription_not_active',
      error: 'Google Play Premium purchase is not active yet.',
    };
  }

  const currentPeriodEnd = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
  if (!currentPeriodEnd || Number.isNaN(currentPeriodEnd.getTime())) {
    return {
      ok: false,
      statusCode: 400,
      code: 'google_play_expiry_missing',
      error: 'Google Play purchase expiry is missing.',
    };
  }

  if (currentPeriodEnd.getTime() <= now.getTime()) {
    return {
      ok: false,
      statusCode: 409,
      code: 'google_play_subscription_expired',
      error: 'Google Play Premium purchase has expired.',
    };
  }

  const obfuscatedAccountId =
    input.purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  const expectedObfuscatedAccountId = getGooglePlayObfuscatedAccountId(input.userId);
  if (obfuscatedAccountId && obfuscatedAccountId !== expectedObfuscatedAccountId) {
    return {
      ok: false,
      statusCode: 403,
      code: 'google_play_account_mismatch',
      error: 'This Google Play purchase belongs to a different Vormex account.',
    };
  }

  const currentPeriodStart = input.purchase.startTime
    ? new Date(input.purchase.startTime)
    : new Date(now);

  return {
    ok: true,
    billingCycle,
    basePlanId,
    productId: config.productId,
    orderId: readOrderId(input.purchase, lineItem),
    subscriptionState,
    acknowledgementState: normalizeState(input.purchase.acknowledgementState),
    currentPeriodStart: Number.isNaN(currentPeriodStart.getTime()) ? new Date(now) : currentPeriodStart,
    currentPeriodEnd,
    linkedPurchaseToken: input.purchase.linkedPurchaseToken || null,
  };
}

async function ensureGooglePlayTokenIsUsable(userId: string, purchaseToken: string) {
  const existingOwner = await prisma.subscriptions.findFirst({
    where: {
      googlePlayPurchaseToken: purchaseToken,
      userId: {
        not: userId,
      },
    },
    select: {
      userId: true,
    },
  });

  if (existingOwner) {
    throw new GooglePlayPremiumVerificationError(
      'This Google Play purchase is already linked to another Vormex account.',
      403,
      'google_play_purchase_token_reused'
    );
  }
}

export async function verifyGooglePlayPremiumPurchase(input: {
  userId: string;
  productId: string;
  purchaseToken: string;
}) {
  const productId = input.productId?.trim();
  const purchaseToken = input.purchaseToken?.trim();
  if (!productId || !purchaseToken) {
    throw new GooglePlayPremiumVerificationError(
      'Missing Google Play purchase verification details.',
      400,
      'google_play_details_missing'
    );
  }

  const config = getGooglePlayPremiumConfig();
  if (!isGooglePlayPremiumConfigured()) {
    throw new GooglePlayPremiumVerificationError(
      'Google Play verification is not configured on the server yet.',
      503,
      'google_play_not_configured'
    );
  }

  await ensureGooglePlayTokenIsUsable(input.userId, purchaseToken);

  const purchase = await fetchGooglePlaySubscriptionPurchase(purchaseToken, config);
  const validation = validateGooglePlayPremiumPurchase({
    userId: input.userId,
    requestedProductId: productId,
    purchaseToken,
    purchase,
    config,
  });

  if (validation.ok === false) {
    throw new GooglePlayPremiumVerificationError(
      validation.error,
      validation.statusCode,
      validation.code
    );
  }

  const snapshot = await getPremiumAccessSnapshot(input.userId);
  const planConfig = buildPremiumPlanConfig(snapshot, validation.billingCycle);
  const subscription = await prisma.subscriptions.upsert({
    where: { userId: input.userId },
    create: {
      id: randomUUID(),
      userId: input.userId,
      plan: getPremiumPlan(),
      status: 'active',
      provider: 'google_play',
      amount: planConfig.amountMinor,
      currency: planConfig.currency,
      billingCycle: validation.billingCycle,
      currentPeriodStart: validation.currentPeriodStart,
      currentPeriodEnd: validation.currentPeriodEnd,
      cancelledAt: null,
      trialEndsAt: null,
      razorpaySubscriptionId: null,
      razorpayCustomerId: null,
      razorpayPlanId: null,
      googlePlayPurchaseToken: purchaseToken,
      googlePlayOrderId: validation.orderId,
      googlePlayProductId: validation.productId,
      googlePlayBasePlanId: validation.basePlanId,
      googlePlaySubscriptionState: validation.subscriptionState,
      googlePlayAcknowledgementState: validation.acknowledgementState,
      lastProviderSyncAt: new Date(),
    },
    update: {
      plan: getPremiumPlan(),
      status: 'active',
      provider: 'google_play',
      amount: planConfig.amountMinor,
      currency: planConfig.currency,
      billingCycle: validation.billingCycle,
      currentPeriodStart: validation.currentPeriodStart,
      currentPeriodEnd: validation.currentPeriodEnd,
      cancelledAt: null,
      trialEndsAt: null,
      razorpaySubscriptionId: null,
      razorpayCustomerId: null,
      razorpayPlanId: null,
      googlePlayPurchaseToken: purchaseToken,
      googlePlayOrderId: validation.orderId,
      googlePlayProductId: validation.productId,
      googlePlayBasePlanId: validation.basePlanId,
      googlePlaySubscriptionState: validation.subscriptionState,
      googlePlayAcknowledgementState: validation.acknowledgementState,
      lastProviderSyncAt: new Date(),
    },
  });

  await prisma.user_feature_access_overrides.updateMany({
    where: { userId: input.userId },
    data: {
      agentBlocked: false,
      profileCustomizationBlocked: false,
    },
  });

  let acknowledgementState = validation.acknowledgementState;
  if (acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
    try {
      await acknowledgeGooglePlaySubscriptionPurchase(purchaseToken, config);
      acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      await prisma.subscriptions.update({
        where: { userId: input.userId },
        data: {
          googlePlayAcknowledgementState: acknowledgementState,
          lastProviderSyncAt: new Date(),
        },
      });
    } catch (error) {
      console.error('Failed to acknowledge Google Play Premium purchase', error);
    }
  }

  await logPremiumCheckoutEvent({
    userId: input.userId,
    eventType: 'CHECKOUT_VERIFIED',
    outcome: 'success',
    message: 'Google Play Premium unlocked successfully.',
    amountMinor: planConfig.amountMinor,
    currency: planConfig.currency,
    metadata: {
      provider: 'google_play',
      productId: validation.productId,
      basePlanId: validation.basePlanId,
      orderId: validation.orderId,
      subscriptionId: subscription.id,
      subscriptionState: validation.subscriptionState,
      acknowledgementState,
    },
  });

  const updatedSnapshot = await getPremiumAccessSnapshot(input.userId);
  return {
    message: 'Premium unlocked successfully.',
    subscription: serializePremiumSubscription(
      updatedSnapshot,
      isGooglePlayPremiumConfigured()
    ),
  };
}
