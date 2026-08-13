import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import type { PremiumPlanConfig } from './premium-checkout.service';

const SETTINGS_ID = 'default';
const DEFAULT_PREMIUM_TITLE = 'Vormex Premium';
const DEFAULT_PREMIUM_DESCRIPTION =
  'Priority discovery, profile boosts, unlimited connection requests, request queue priority, featured placement, profile projects, collaboration applications, and AI help for serious student builders.';
const DEFAULT_CREATOR_PRO_TITLE = 'Vormex Creator Pro';
const DEFAULT_CREATOR_PRO_DESCRIPTION =
  'A higher tier for creators who want audience analytics, collab priority, monetized DMs, paid sessions, and portfolio amplification.';
const DEFAULT_PREMIUM_FEATURES = [
  'Priority discovery placement',
  'Premium badge for higher trust',
  'Profile boosts for higher discovery ranking',
  'Be seen first in request inboxes',
  'Featured placement in relevant feeds',
  'Better chances of profile views',
  'Unlimited connection requests',
  'Unlimited teammate post applications',
  'Unlimited hackathon team applications',
  'Up to 10 profile projects',
  'Featured project showcase',
  'Unlimited AI Agent prompts',
  'AI teammate finder',
  'AI pitch, bio, and hackathon idea generator',
  'Open to collaborate badge',
  'Profile frames and visitor animations',
];
const DEFAULT_CREATOR_PRO_FEATURES = [
  'Audience and collab analytics',
  'Priority in the collab marketplace',
  'Monetized DMs and paid 1:1 session setup',
  'Showcase and portfolio amplification',
  'Premium features included',
];
const DEFAULT_PREMIUM_DURATION_DAYS = 31;
const DEFAULT_SUPPORT_LABEL = '24/7 fast support';
const DEFAULT_AGENT_PROMPT_LIMIT = 5;
const DEFAULT_YEARLY_PREMIUM_AMOUNT_MINOR = 99900;
const DEFAULT_CREATOR_PRO_MONTHLY_AMOUNT_MINOR = 49900;
const DEFAULT_CREATOR_PRO_YEARLY_AMOUNT_MINOR = 299900;
/**
 * Provider value written by the removed developer/test premium override. Rows that still
 * carry it are leftover test grants, so they are treated as inactive everywhere premium
 * access is evaluated. Real access must come from a captured Razorpay or Google Play payment.
 */
export const LEGACY_TEST_PREMIUM_PROVIDER = 'developer_override';

export const ACTIVE_PREMIUM_STATUSES = new Set(['active', 'captured', 'authorized']);

type AppFeatureSettingsRecord = NonNullable<
  Awaited<ReturnType<typeof prisma.app_feature_settings.findUnique>>
>;
type UserFeatureOverrideRecord = Awaited<
  ReturnType<typeof prisma.user_feature_access_overrides.findUnique>
>;
type SubscriptionRecord = Awaited<ReturnType<typeof prisma.subscriptions.findUnique>>;
type AccessUserRecord = {
  id: string;
  isAdmin: boolean;
  email: string;
};

export type AgentAvailabilityMode = 'all' | 'selected' | 'disabled';

export interface PremiumAccessSnapshot {
  settings: AppFeatureSettingsRecord;
  override: UserFeatureOverrideRecord;
  subscription: SubscriptionRecord;
  user: AccessUserRecord;
  isPremium: boolean;
  isCreatorPro: boolean;
  canUseAgent: boolean;
  canAccessProfileCustomization: boolean;
  premiumAmountMinor: number;
  premiumCurrency: string;
  premiumDisplayAmount: string;
  customPriceApplied: boolean;
  premiumStartedAt: Date | null;
  premiumEndsAt: Date | null;
  premiumDurationDays: number;
  premiumDaysRemaining: number;
  autoPayEnabled: boolean;
  creditsUsed: number;
  agentPromptLimit: number;
  agentLimitReached: boolean;
  canCancelPremium: boolean;
  canManageInGooglePlay: boolean;
  provider: string;
}

export interface PremiumPlanOption {
  billingCycle: string;
  amountMinor: number;
  currency: string;
  displayAmount: string;
  durationDays: number;
  label: string;
  savingsLabel: string | null;
}

export interface AgentAccessState {
  canUseAgent: boolean;
  agentPromptLimit: number;
  agentLimitReached: boolean;
}

export interface PremiumCheckoutEventInput {
  userId: string;
  eventType:
    | 'CLICKED_GET_PREMIUM'
    | 'CHECKOUT_CREATED'
    | 'CHECKOUT_FAILED'
    | 'CHECKOUT_BLOCKED'
    | 'CHECKOUT_VERIFIED'
    | 'CHECKOUT_WEBHOOK'
    | 'SUBSCRIPTION_CANCELLED'
    | 'ADMIN_CANCELLED_SUBSCRIPTION'
    | 'TEST_PREMIUM_REVOKED'
    | 'PROFILE_BOOST_ACTIVATED';
  outcome?: 'info' | 'success' | 'failure';
  message?: string;
  amountMinor?: number | null;
  currency?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

function readPositiveIntEnv(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function getDefaultPremiumAmountMinor(billingCycle = getPremiumBillingCycle()) {
  const normalizedBillingCycle = normalizePremiumBillingCycle(billingCycle);
  if (normalizedBillingCycle === 'yearly') {
    return readPositiveIntEnv(
      'VORMEX_PREMIUM_YEARLY_AMOUNT_MINOR',
      DEFAULT_YEARLY_PREMIUM_AMOUNT_MINOR
    );
  }

  return readPositiveIntEnv(
    'VORMEX_PREMIUM_MONTHLY_AMOUNT_MINOR',
    readPositiveIntEnv('VORMEX_PREMIUM_AMOUNT_MINOR', 19900)
  );
}

function getDefaultPremiumCurrency() {
  return (process.env.VORMEX_PREMIUM_CURRENCY || 'INR').toUpperCase();
}

function getDefaultCreatorProAmountMinor(billingCycle = getPremiumBillingCycle()) {
  const normalizedBillingCycle = normalizePremiumBillingCycle(billingCycle);
  if (normalizedBillingCycle === 'yearly') {
    return readPositiveIntEnv(
      'VORMEX_CREATOR_PRO_YEARLY_AMOUNT_MINOR',
      DEFAULT_CREATOR_PRO_YEARLY_AMOUNT_MINOR
    );
  }

  return readPositiveIntEnv(
    'VORMEX_CREATOR_PRO_MONTHLY_AMOUNT_MINOR',
    DEFAULT_CREATOR_PRO_MONTHLY_AMOUNT_MINOR
  );
}

export function getPremiumDurationDays() {
  const durationDays = Number(
    process.env.VORMEX_PREMIUM_DURATION_DAYS || DEFAULT_PREMIUM_DURATION_DAYS
  );
  return Number.isFinite(durationDays) && durationDays > 0
    ? Math.round(durationDays)
    : DEFAULT_PREMIUM_DURATION_DAYS;
}

export function getPremiumDurationDaysForBillingCycle(billingCycle = getPremiumBillingCycle()) {
  const normalizedBillingCycle = normalizePremiumBillingCycle(billingCycle);
  if (normalizedBillingCycle === 'yearly') {
    return readPositiveIntEnv('VORMEX_PREMIUM_YEARLY_DURATION_DAYS', 365);
  }

  return readPositiveIntEnv(
    'VORMEX_PREMIUM_MONTHLY_DURATION_DAYS',
    getPremiumDurationDays()
  );
}

export function getPremiumPlan() {
  return process.env.VORMEX_PREMIUM_PLAN || 'premium';
}

export function getCreatorProPlan() {
  return process.env.VORMEX_CREATOR_PRO_PLAN || 'creator_pro';
}

export function normalizeSubscriptionPlan(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

export function isCreatorProPlan(value: string | null | undefined) {
  const normalized = normalizeSubscriptionPlan(value);
  const configured = normalizeSubscriptionPlan(getCreatorProPlan());
  return normalized === configured || normalized === 'creator_pro' || normalized === 'creatorpro';
}

export function isPremiumEntitlementPlan(value: string | null | undefined) {
  const normalized = normalizeSubscriptionPlan(value);
  return normalized === normalizeSubscriptionPlan(getPremiumPlan()) || isCreatorProPlan(normalized);
}

export function normalizePremiumCheckoutPlan(value: string | null | undefined) {
  return isCreatorProPlan(value) ? getCreatorProPlan() : getPremiumPlan();
}

export function getPremiumBillingCycle() {
  return normalizePremiumBillingCycle(process.env.VORMEX_PREMIUM_BILLING_CYCLE || 'monthly');
}

export function normalizePremiumBillingCycle(value: string | null | undefined) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'yearly' || normalized === 'annual' || normalized === 'annually') {
    return 'yearly';
  }
  return 'monthly';
}

export function getPremiumTitle() {
  return process.env.VORMEX_PREMIUM_TITLE || DEFAULT_PREMIUM_TITLE;
}

export function getPremiumDescription() {
  return process.env.VORMEX_PREMIUM_DESCRIPTION || DEFAULT_PREMIUM_DESCRIPTION;
}

export function getCreatorProTitle() {
  return process.env.VORMEX_CREATOR_PRO_TITLE || DEFAULT_CREATOR_PRO_TITLE;
}

export function getCreatorProDescription() {
  return process.env.VORMEX_CREATOR_PRO_DESCRIPTION || DEFAULT_CREATOR_PRO_DESCRIPTION;
}

export function getPremiumFeatureLabels() {
  return DEFAULT_PREMIUM_FEATURES;
}

export function getCreatorProFeatureLabels() {
  return DEFAULT_CREATOR_PRO_FEATURES;
}

export function getPremiumSupportLabel() {
  return DEFAULT_SUPPORT_LABEL;
}

export function isLegacyTestPremiumSubscription(
  subscription: Pick<NonNullable<SubscriptionRecord>, 'provider'> | null | undefined
) {
  return subscription?.provider === LEGACY_TEST_PREMIUM_PROVIDER;
}

export function getAgentPromptLimit() {
  const rawLimit = Number(
    process.env.VORMEX_AGENT_PROMPT_LIMIT ||
      process.env.VORMEX_AGENT_MESSAGE_LIMIT ||
      DEFAULT_AGENT_PROMPT_LIMIT
  );

  if (!Number.isFinite(rawLimit)) {
    return DEFAULT_AGENT_PROMPT_LIMIT;
  }

  return Math.max(0, Math.round(rawLimit));
}

export function getPremiumRenewalModeLabel(autoPayEnabled: boolean) {
  return autoPayEnabled ? 'Auto-pay active' : 'Manual renewal';
}

export function formatCurrency(amountMinor: number, currency: string) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

export function normalizeAgentAvailabilityMode(value: string | null | undefined): AgentAvailabilityMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'selected') return 'selected';
  if (normalized === 'disabled') return 'disabled';
  return 'all';
}

export function evaluateAgentAccess(params: {
  isAdmin: boolean;
  isPremium: boolean;
  agentMode: AgentAvailabilityMode;
  agentEnabled: boolean;
  agentBlocked: boolean;
  creditsUsed: number;
  agentPromptLimit?: number;
}): AgentAccessState {
  const agentPromptLimit = params.agentPromptLimit ?? getAgentPromptLimit();
  const baseAccess =
    params.isAdmin ||
    (!params.agentBlocked &&
      params.agentMode !== 'disabled' &&
      params.isPremium);
  const agentLimitReached = false;

  return {
    canUseAgent: baseAccess && !agentLimitReached,
    agentPromptLimit,
    agentLimitReached,
  };
}

export function getAgentAccessDeniedMessage(params: Pick<AgentAccessState, 'agentLimitReached' | 'agentPromptLimit'>) {
  if (params.agentLimitReached) {
    if (params.agentPromptLimit > 0) {
      return `You've reached the current AI Agent limit of ${params.agentPromptLimit} prompts for this account.`;
    }
    return 'AI Agent is temporarily unavailable for this account right now.';
  }

  return 'Vormex AI Agent is a Premium feature. Upgrade to Premium or Creator Pro to use Power Mode.';
}

export function getPremiumPeriodEnd(startAt: Date, durationDays = getPremiumDurationDays()) {
  const endAt = new Date(startAt);
  endAt.setUTCDate(endAt.getUTCDate() + durationDays);
  return endAt;
}

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

export function serializePremiumSubscription(
  snapshot: PremiumAccessSnapshot,
  checkoutEnabled: boolean
) {
  return {
    plan: snapshot.subscription?.plan || 'free',
    status: snapshot.subscription?.status || 'inactive',
    provider: snapshot.provider,
    isPremium: snapshot.isPremium,
    isCreatorPro: snapshot.isCreatorPro,
    title: getPremiumTitle(),
    description: getPremiumDescription(),
    amountMinor: snapshot.premiumAmountMinor,
    currency: snapshot.premiumCurrency,
    displayAmount: snapshot.premiumDisplayAmount,
    billingCycle: normalizePremiumBillingCycle(snapshot.subscription?.billingCycle || getPremiumBillingCycle()),
    checkoutEnabled,
    ctaLabel: snapshot.isPremium ? 'Premium active' : 'Go Premium',
    features: getPremiumFeatureLabels(),
    canUseAgent: snapshot.canUseAgent,
    canAccessProfileCustomization: snapshot.canAccessProfileCustomization,
    customPriceApplied: snapshot.customPriceApplied,
    premiumStartedAt: snapshot.premiumStartedAt,
    premiumEndsAt: snapshot.premiumEndsAt,
    premiumDurationDays: snapshot.premiumDurationDays,
    premiumDaysRemaining: snapshot.premiumDaysRemaining,
    autoPayEnabled: snapshot.autoPayEnabled,
    renewalModeLabel: getPremiumRenewalModeLabel(snapshot.autoPayEnabled),
    supportLabel: getPremiumSupportLabel(),
    creditsUsed: snapshot.creditsUsed,
    agentPromptLimit: snapshot.agentPromptLimit,
    agentLimitReached: snapshot.agentLimitReached,
    canCancel: snapshot.canCancelPremium,
    canManageInGooglePlay: snapshot.canManageInGooglePlay,
    googlePlayProductId: snapshot.subscription?.googlePlayProductId || null,
    googlePlayBasePlanId: snapshot.subscription?.googlePlayBasePlanId || null,
    googlePlaySubscriptionState: snapshot.subscription?.googlePlaySubscriptionState || null,
    planOptions: getPremiumPlanOptions(snapshot.premiumCurrency),
    creatorPro: {
      plan: getCreatorProPlan(),
      isActive: snapshot.isCreatorPro,
      title: getCreatorProTitle(),
      description: getCreatorProDescription(),
      ctaLabel: snapshot.isCreatorPro ? 'Creator Pro active' : 'Upgrade to Creator Pro',
      features: getCreatorProFeatureLabels(),
      planOptions: getCreatorProPlanOptions(snapshot.premiumCurrency),
    },
  };
}

export async function logPremiumCheckoutEvent(input: PremiumCheckoutEventInput) {
  try {
    await prisma.premium_checkout_events.create({
      data: {
        userId: input.userId,
        eventType: input.eventType,
        outcome: input.outcome || 'info',
        message: input.message || null,
        amountMinor: input.amountMinor ?? null,
        currency: input.currency ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
  } catch (error) {
    console.error('Failed to log premium checkout event', error);
  }
}
