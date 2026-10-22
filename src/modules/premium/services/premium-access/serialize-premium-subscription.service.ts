import { Prisma } from "@prisma/client";
import { prisma } from "../../../../config/prisma";
import { PremiumAccessSnapshot, getPremiumTitle, getPremiumDescription, normalizePremiumBillingCycle, getPremiumBillingCycle, getPremiumFeatureLabels, getPremiumRenewalModeLabel, getPremiumSupportLabel, getCreatorProPlan, getCreatorProTitle, getCreatorProDescription, getCreatorProFeatureLabels, PremiumCheckoutEventInput } from "./legacy-test-premium-provider.service";
import { getPremiumPlanOptions, getCreatorProPlanOptions } from "./get-premium-plan-options.service";

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
