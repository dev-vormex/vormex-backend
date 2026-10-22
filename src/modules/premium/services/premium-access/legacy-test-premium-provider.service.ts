import { normalizePremiumBillingCycle } from "../../utils/billing-cycle.util";
import { roundedPositiveIntEnv as readPositiveIntEnv } from "../../../../config/env.util";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../../config/prisma";

export const SETTINGS_ID = 'default';

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

export type AppFeatureSettingsRecord = NonNullable<
  Awaited<ReturnType<typeof prisma.app_feature_settings.findUnique>>
>;

type UserFeatureOverrideRecord = Awaited<
  ReturnType<typeof prisma.user_feature_access_overrides.findUnique>
>;

export type SubscriptionRecord = Awaited<ReturnType<typeof prisma.subscriptions.findUnique>>;

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



export function getDefaultPremiumAmountMinor(billingCycle = getPremiumBillingCycle()) {
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

export function getDefaultPremiumCurrency() {
  return (process.env.VORMEX_PREMIUM_CURRENCY || 'INR').toUpperCase();
}

export function getDefaultCreatorProAmountMinor(billingCycle = getPremiumBillingCycle()) {
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

export { normalizePremiumBillingCycle } from "../../utils/billing-cycle.util";

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
