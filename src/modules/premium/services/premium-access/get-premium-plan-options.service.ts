import { randomUUID } from "crypto";
import { prisma } from "../../../../config/prisma";
import type { PremiumPlanConfig } from "../premium-checkout.service";
import { getDefaultPremiumCurrency, PremiumPlanOption, getDefaultPremiumAmountMinor, formatCurrency, getPremiumDurationDaysForBillingCycle, getDefaultCreatorProAmountMinor, AppFeatureSettingsRecord, SETTINGS_ID, SubscriptionRecord, isLegacyTestPremiumSubscription, isPremiumEntitlementPlan, ACTIVE_PREMIUM_STATUSES, isCreatorProPlan, getPremiumPlan, getPremiumBillingCycle, LEGACY_TEST_PREMIUM_PROVIDER, PremiumAccessSnapshot, normalizePremiumBillingCycle, normalizeAgentAvailabilityMode, getPremiumPeriodEnd, evaluateAgentAccess, normalizePremiumCheckoutPlan, getCreatorProTitle, getPremiumTitle, getCreatorProDescription, getPremiumDescription, getCreatorProFeatureLabels, getPremiumFeatureLabels } from "./legacy-test-premium-provider.service";

export function getPremiumPlanOptions(currency = getDefaultPremiumCurrency()): PremiumPlanOption[] {
  const monthlyAmount = getDefaultPremiumAmountMinor('monthly');
  const yearlyAmount = getDefaultPremiumAmountMinor('yearly');
  const yearlySavings = Math.max(0, monthlyAmount * 12 - yearlyAmount);

  return [
    {
      billingCycle: 'monthly',
      amountMinor: monthlyAmount,
      currency,
      displayAmount: formatCurrency(monthlyAmount, currency),
      durationDays: getPremiumDurationDaysForBillingCycle('monthly'),
      label: 'Monthly',
      savingsLabel: null,
    },
    {
      billingCycle: 'yearly',
      amountMinor: yearlyAmount,
      currency,
      displayAmount: formatCurrency(yearlyAmount, currency),
      durationDays: getPremiumDurationDaysForBillingCycle('yearly'),
      label: 'Yearly',
      savingsLabel: yearlySavings > 0 ? `Save ${formatCurrency(yearlySavings, currency)}` : null,
    },
  ];
}

export function getCreatorProPlanOptions(currency = getDefaultPremiumCurrency()): PremiumPlanOption[] {
  const monthlyAmount = getDefaultCreatorProAmountMinor('monthly');
  const yearlyAmount = getDefaultCreatorProAmountMinor('yearly');
  const yearlySavings = Math.max(0, monthlyAmount * 12 - yearlyAmount);

  return [
    {
      billingCycle: 'monthly',
      amountMinor: monthlyAmount,
      currency,
      displayAmount: formatCurrency(monthlyAmount, currency),
      durationDays: getPremiumDurationDaysForBillingCycle('monthly'),
      label: 'Creator Pro Monthly',
      savingsLabel: null,
    },
    {
      billingCycle: 'yearly',
      amountMinor: yearlyAmount,
      currency,
      displayAmount: formatCurrency(yearlyAmount, currency),
      durationDays: getPremiumDurationDaysForBillingCycle('yearly'),
      label: 'Creator Pro Yearly',
      savingsLabel: yearlySavings > 0 ? `Save ${formatCurrency(yearlySavings, currency)}` : null,
    },
  ];
}

export function getPremiumDaysRemaining(
  currentPeriodEnd: Date | null | undefined,
  now = new Date()
) {
  if (!currentPeriodEnd) {
    return 0;
  }

  const remainingMs = currentPeriodEnd.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

export async function getOrCreateAppFeatureSettings(): Promise<AppFeatureSettingsRecord> {
  return prisma.app_feature_settings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: {
      id: SETTINGS_ID,
      premiumDefaultAmountMinor: getDefaultPremiumAmountMinor('monthly'),
      premiumCurrency: getDefaultPremiumCurrency(),
      agentAvailabilityMode: 'all',
    },
  });
}

export function isPremiumSubscriptionActive(
  subscription:
    | Pick<
        NonNullable<SubscriptionRecord>,
        'plan' | 'status' | 'provider' | 'currentPeriodEnd' | 'cancelledAt'
      >
    | null
    | undefined,
  now = new Date()
) {
  if (!subscription) {
    return false;
  }

  if (isLegacyTestPremiumSubscription(subscription)) {
    return false;
  }

  if (subscription.cancelledAt && subscription.cancelledAt.getTime() <= now.getTime()) {
    return false;
  }

  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= now.getTime()) {
    return false;
  }

  return (
    isPremiumEntitlementPlan(subscription.plan) &&
    ACTIVE_PREMIUM_STATUSES.has(String(subscription.status || '').toLowerCase())
  );
}

export function isCreatorProSubscriptionActive(
  subscription:
    | Pick<
        NonNullable<SubscriptionRecord>,
        'plan' | 'status' | 'provider' | 'currentPeriodEnd' | 'cancelledAt'
      >
    | null
    | undefined,
  now = new Date()
) {
  if (!subscription) {
    return false;
  }

  if (isLegacyTestPremiumSubscription(subscription)) {
    return false;
  }

  if (subscription.cancelledAt && subscription.cancelledAt.getTime() <= now.getTime()) {
    return false;
  }

  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= now.getTime()) {
    return false;
  }

  return (
    isCreatorProPlan(subscription.plan) &&
    ACTIVE_PREMIUM_STATUSES.has(String(subscription.status || '').toLowerCase())
  );
}

export async function cancelPremiumSubscription(
  userId: string,
  reason: 'user' | 'admin'
): Promise<SubscriptionRecord> {
  const now = new Date();

  return prisma.subscriptions.upsert({
    where: { userId },
    create: {
      id: randomUUID(),
      userId,
      plan: getPremiumPlan(),
      status: reason === 'admin' ? 'revoked' : 'cancelled',
      amount: null,
      currency: getDefaultPremiumCurrency(),
      billingCycle: getPremiumBillingCycle(),
      provider: 'manual',
      currentPeriodStart: now,
      currentPeriodEnd: now,
      cancelledAt: now,
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
      status: reason === 'admin' ? 'revoked' : 'cancelled',
      currentPeriodEnd: now,
      cancelledAt: now,
      lastProviderSyncAt: now,
    },
  });
}

/**
 * Revokes any premium row that was created by the removed test/developer override so
 * leftover grants stop unlocking paid features. Returns the number of rows revoked.
 */
export async function revokeLegacyTestPremiumSubscriptions(): Promise<string[]> {
  const now = new Date();
  const legacyRows = await prisma.subscriptions.findMany({
    where: { provider: LEGACY_TEST_PREMIUM_PROVIDER },
    select: { userId: true },
  });

  if (legacyRows.length === 0) {
    return [];
  }

  await prisma.subscriptions.updateMany({
    where: { provider: LEGACY_TEST_PREMIUM_PROVIDER },
    data: {
      status: 'revoked',
      currentPeriodEnd: now,
      cancelledAt: now,
      lastProviderSyncAt: now,
    },
  });

  return legacyRows.map((row) => row.userId);
}

export async function getPremiumAccessSnapshot(userId: string): Promise<PremiumAccessSnapshot> {
  const [settings, override, subscription, user] = await Promise.all([
    getOrCreateAppFeatureSettings(),
    prisma.user_feature_access_overrides.findUnique({ where: { userId } }),
    prisma.subscriptions.findUnique({ where: { userId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isAdmin: true,
        email: true,
      },
    }),
  ]);

  if (!user) {
    throw new Error('User not found');
  }

  const configuredPremiumAmountMinor =
    typeof override?.premiumPriceOverrideMinor === 'number' && override.premiumPriceOverrideMinor > 0
      ? override.premiumPriceOverrideMinor
    : settings.premiumDefaultAmountMinor || getDefaultPremiumAmountMinor('monthly');
  const now = new Date();
  const isPremium = isPremiumSubscriptionActive(subscription, now);
  const isCreatorPro = isCreatorProSubscriptionActive(subscription, now);
  const activeBillingCycle = normalizePremiumBillingCycle(
    subscription?.billingCycle || getPremiumBillingCycle()
  );
  const premiumDurationDays = getPremiumDurationDaysForBillingCycle(activeBillingCycle);
  const premiumAmountMinor =
    isPremium && typeof subscription?.amount === 'number' && subscription.amount > 0
      ? subscription.amount
      : isCreatorPro
        ? getDefaultCreatorProAmountMinor(activeBillingCycle)
      : configuredPremiumAmountMinor;
  const premiumCurrency = (isPremium && subscription?.currency) || settings.premiumCurrency || getDefaultPremiumCurrency();
  const agentMode = normalizeAgentAvailabilityMode(settings.agentAvailabilityMode);
  const premiumStartedAt = subscription?.currentPeriodStart || null;
  const premiumEndsAt =
    subscription?.currentPeriodEnd ||
    (subscription?.currentPeriodStart ? getPremiumPeriodEnd(subscription.currentPeriodStart) : null);
  const premiumDaysRemaining = isPremium ? getPremiumDaysRemaining(premiumEndsAt, now) : 0;
  const provider =
    subscription?.provider ||
    (subscription?.razorpaySubscriptionId ? 'razorpay' : 'manual');
  const autoPayEnabled = Boolean(subscription?.razorpaySubscriptionId);
  const canCancelPremium =
    provider !== 'google_play' && (isPremium || Boolean(subscription?.razorpaySubscriptionId));
  const canManageInGooglePlay =
    provider === 'google_play' && Boolean(subscription?.googlePlayProductId);
  const creditsWindowStart = isPremium
    ? (premiumStartedAt || new Date(now.getTime() - premiumDurationDays * 24 * 60 * 60 * 1000))
    : new Date(0);
  const creditsUsed = await prisma.agent_messages.count({
    where: {
      userId,
      role: 'user',
      createdAt: {
        gte: creditsWindowStart,
        lte: now,
      },
    },
  });
  const agentAccess = evaluateAgentAccess({
    isAdmin: user.isAdmin,
    isPremium,
    agentMode,
    agentEnabled: Boolean(override?.agentEnabled),
    agentBlocked: Boolean(override?.agentBlocked),
    creditsUsed,
  });
  const canAccessProfileCustomization =
    user.isAdmin ||
    (!override?.profileCustomizationBlocked &&
      (isPremium || Boolean(override?.profileCustomizationGranted)));

  return {
    settings,
    override,
    subscription,
    user,
    isPremium,
    isCreatorPro,
    canUseAgent: agentAccess.canUseAgent,
    canAccessProfileCustomization,
    premiumAmountMinor,
    premiumCurrency,
    premiumDisplayAmount: formatCurrency(premiumAmountMinor, premiumCurrency),
    customPriceApplied:
      typeof override?.premiumPriceOverrideMinor === 'number' && override.premiumPriceOverrideMinor > 0,
    premiumStartedAt,
    premiumEndsAt,
    premiumDurationDays,
    premiumDaysRemaining,
    autoPayEnabled,
    creditsUsed,
    agentPromptLimit: agentAccess.agentPromptLimit,
    agentLimitReached: agentAccess.agentLimitReached,
    canCancelPremium,
    canManageInGooglePlay,
    provider,
  };
}

export function buildPremiumPlanConfig(
  snapshot: Pick<PremiumAccessSnapshot, 'premiumAmountMinor' | 'premiumCurrency'>,
  billingCycle = getPremiumBillingCycle(),
  plan = getPremiumPlan()
): PremiumPlanConfig & { title: string; description: string; features: string[] } {
  const normalizedBillingCycle = normalizePremiumBillingCycle(billingCycle);
  const normalizedPlan = normalizePremiumCheckoutPlan(plan);
  const isCreatorProCheckout = isCreatorProPlan(normalizedPlan);
  const planOptions = isCreatorProCheckout
    ? getCreatorProPlanOptions(snapshot.premiumCurrency)
    : getPremiumPlanOptions(snapshot.premiumCurrency);
  const planOption = planOptions
    .find((option) => option.billingCycle === normalizedBillingCycle);

  return {
    amountMinor: planOption?.amountMinor || snapshot.premiumAmountMinor,
    currency: snapshot.premiumCurrency,
    plan: normalizedPlan,
    billingCycle: normalizedBillingCycle,
    title: isCreatorProCheckout ? getCreatorProTitle() : getPremiumTitle(),
    description: isCreatorProCheckout ? getCreatorProDescription() : getPremiumDescription(),
    features: isCreatorProCheckout ? getCreatorProFeatureLabels() : getPremiumFeatureLabels(),
  };
}
