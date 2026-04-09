import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import type { PremiumPlanConfig } from './premium-checkout.service';

const SETTINGS_ID = 'default';
const DEFAULT_PREMIUM_TITLE = 'Vormex Premium';
const DEFAULT_PREMIUM_DESCRIPTION =
  'Unlock AI Agent access, premium profile styling, new sections, standout posts, custom visitor looks, featured cards, themes, blocking tools, and fast support.';
const DEFAULT_PREMIUM_FEATURES = [
  'AI Agent access',
  'Unlock new sections',
  'Premium themes',
  'Premium post styling',
  'Custom profile visitor look',
  'Featured card designs',
  'Block people controls',
  '24/7 fast support',
];
const DEFAULT_PREMIUM_DURATION_DAYS = 31;
const DEFAULT_SUPPORT_LABEL = '24/7 fast support';

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
};

export type AgentAvailabilityMode = 'all' | 'selected' | 'disabled';

export interface PremiumAccessSnapshot {
  settings: AppFeatureSettingsRecord;
  override: UserFeatureOverrideRecord;
  subscription: SubscriptionRecord;
  user: AccessUserRecord;
  isPremium: boolean;
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
  canCancelPremium: boolean;
}

export interface PremiumCheckoutEventInput {
  userId: string;
  eventType:
    | 'CLICKED_GET_PREMIUM'
    | 'CHECKOUT_CREATED'
    | 'CHECKOUT_FAILED'
    | 'CHECKOUT_BLOCKED'
    | 'CHECKOUT_VERIFIED'
    | 'SUBSCRIPTION_CANCELLED'
    | 'ADMIN_CANCELLED_SUBSCRIPTION';
  outcome?: 'info' | 'success' | 'failure';
  message?: string;
  amountMinor?: number | null;
  currency?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

function getDefaultPremiumAmountMinor() {
  const amountMinor = Number(process.env.VORMEX_PREMIUM_AMOUNT_MINOR || 19900);
  return Number.isFinite(amountMinor) && amountMinor > 0 ? Math.round(amountMinor) : 19900;
}

function getDefaultPremiumCurrency() {
  return (process.env.VORMEX_PREMIUM_CURRENCY || 'INR').toUpperCase();
}

export function getPremiumDurationDays() {
  const durationDays = Number(
    process.env.VORMEX_PREMIUM_DURATION_DAYS || DEFAULT_PREMIUM_DURATION_DAYS
  );
  return Number.isFinite(durationDays) && durationDays > 0
    ? Math.round(durationDays)
    : DEFAULT_PREMIUM_DURATION_DAYS;
}

export function getPremiumPlan() {
  return process.env.VORMEX_PREMIUM_PLAN || 'premium';
}

export function getPremiumBillingCycle() {
  return process.env.VORMEX_PREMIUM_BILLING_CYCLE || 'one_time';
}

export function getPremiumTitle() {
  return process.env.VORMEX_PREMIUM_TITLE || DEFAULT_PREMIUM_TITLE;
}

export function getPremiumDescription() {
  return process.env.VORMEX_PREMIUM_DESCRIPTION || DEFAULT_PREMIUM_DESCRIPTION;
}

export function getPremiumFeatureLabels() {
  return DEFAULT_PREMIUM_FEATURES;
}

export function getPremiumSupportLabel() {
  return DEFAULT_SUPPORT_LABEL;
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

export function getPremiumPeriodEnd(startAt: Date, durationDays = getPremiumDurationDays()) {
  const endAt = new Date(startAt);
  endAt.setUTCDate(endAt.getUTCDate() + durationDays);
  return endAt;
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
      premiumDefaultAmountMinor: getDefaultPremiumAmountMinor(),
      premiumCurrency: getDefaultPremiumCurrency(),
      agentAvailabilityMode: 'all',
    },
  });
}

export function isPremiumSubscriptionActive(
  subscription:
    | Pick<
        NonNullable<SubscriptionRecord>,
        'plan' | 'status' | 'currentPeriodEnd' | 'cancelledAt'
      >
    | null
    | undefined,
  now = new Date()
) {
  if (!subscription) {
    return false;
  }

  if (subscription.cancelledAt && subscription.cancelledAt.getTime() <= now.getTime()) {
    return false;
  }

  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd.getTime() <= now.getTime()) {
    return false;
  }

  return (
    subscription.plan === getPremiumPlan() &&
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
      currentPeriodStart: now,
      currentPeriodEnd: now,
      cancelledAt: now,
      trialEndsAt: null,
      razorpaySubscriptionId: null,
      razorpayCustomerId: null,
      razorpayPlanId: null,
    },
    update: {
      status: reason === 'admin' ? 'revoked' : 'cancelled',
      currentPeriodEnd: now,
      cancelledAt: now,
    },
  });
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
      },
    }),
  ]);

  if (!user) {
    throw new Error('User not found');
  }

  const premiumAmountMinor =
    typeof override?.premiumPriceOverrideMinor === 'number' && override.premiumPriceOverrideMinor > 0
      ? override.premiumPriceOverrideMinor
      : settings.premiumDefaultAmountMinor;
  const premiumCurrency = settings.premiumCurrency || getDefaultPremiumCurrency();
  const now = new Date();
  const premiumDurationDays = getPremiumDurationDays();
  const isPremium = isPremiumSubscriptionActive(subscription, now);
  const agentMode = normalizeAgentAvailabilityMode(settings.agentAvailabilityMode);
  const premiumStartedAt = subscription?.currentPeriodStart || null;
  const premiumEndsAt =
    subscription?.currentPeriodEnd ||
    (subscription?.currentPeriodStart ? getPremiumPeriodEnd(subscription.currentPeriodStart) : null);
  const premiumDaysRemaining = isPremium ? getPremiumDaysRemaining(premiumEndsAt, now) : 0;
  const autoPayEnabled = Boolean(subscription?.razorpaySubscriptionId);
  const canCancelPremium = isPremium || Boolean(subscription?.razorpaySubscriptionId);
  const creditsWindowStart =
    premiumStartedAt || new Date(now.getTime() - premiumDurationDays * 24 * 60 * 60 * 1000);
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
  const canUseAgent =
    user.isAdmin ||
    (!override?.agentBlocked &&
      agentMode !== 'disabled' &&
      (isPremium ||
        agentMode === 'all' ||
        (agentMode === 'selected' && Boolean(override?.agentEnabled))));
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
    canUseAgent,
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
    canCancelPremium,
  };
}

export function buildPremiumPlanConfig(
  snapshot: Pick<PremiumAccessSnapshot, 'premiumAmountMinor' | 'premiumCurrency'>
): PremiumPlanConfig & { title: string; description: string; features: string[] } {
  return {
    amountMinor: snapshot.premiumAmountMinor,
    currency: snapshot.premiumCurrency,
    plan: getPremiumPlan(),
    billingCycle: getPremiumBillingCycle(),
    title: getPremiumTitle(),
    description: getPremiumDescription(),
    features: getPremiumFeatureLabels(),
  };
}

export function serializePremiumSubscription(
  snapshot: PremiumAccessSnapshot,
  checkoutEnabled: boolean
) {
  return {
    plan: snapshot.subscription?.plan || 'free',
    status: snapshot.subscription?.status || 'inactive',
    isPremium: snapshot.isPremium,
    title: getPremiumTitle(),
    description: getPremiumDescription(),
    amountMinor: snapshot.premiumAmountMinor,
    currency: snapshot.premiumCurrency,
    displayAmount: snapshot.premiumDisplayAmount,
    billingCycle: getPremiumBillingCycle(),
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
    canCancel: snapshot.canCancelPremium,
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
