import { Response } from "express";
import { getOrCreateAppFeatureSettings, isPremiumSubscriptionActive, normalizeAgentAvailabilityMode, formatCurrency } from "../../services/premium-access.service";
import { prisma } from "../../../../config/prisma";
import { AuthRequest, buildEventPaymentRef, parsePositiveInt } from "./support.controller";

export const getPremiumAdminOverview = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const settings = await getOrCreateAppFeatureSettings();
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
    );
    const [
      subscriptions,
      customPriceUsers,
      agentSelectedUsers,
      profileCustomizationGrantedUsers,
      clickCount,
      failureCount,
      successCount,
      paymentTotals,
      paymentTotalsThisMonth,
      lastPayment,
    ] = await Promise.all([
      prisma.subscriptions.findMany({
        select: {
          plan: true,
          status: true,
          provider: true,
          amount: true,
          currency: true,
          currentPeriodEnd: true,
          cancelledAt: true,
        },
      }),
      prisma.user_feature_access_overrides.count({
        where: {
          premiumPriceOverrideMinor: {
            not: null,
          },
        },
      }),
      prisma.user_feature_access_overrides.count({
        where: {
          agentEnabled: true,
        },
      }),
      prisma.user_feature_access_overrides.count({
        where: {
          profileCustomizationGranted: true,
        },
      }),
      prisma.premium_checkout_events.count({
        where: {
          eventType: 'CLICKED_GET_PREMIUM',
        },
      }),
      prisma.premium_checkout_events.count({
        where: {
          outcome: 'failure',
        },
      }),
      prisma.premium_checkout_events.count({
        where: {
          outcome: 'success',
        },
      }),
      prisma.premium_checkout_events.aggregate({
        where: { eventType: 'CHECKOUT_VERIFIED', outcome: 'success' },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      prisma.premium_checkout_events.aggregate({
        where: {
          eventType: 'CHECKOUT_VERIFIED',
          outcome: 'success',
          createdAt: { gte: monthStart },
        },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      prisma.premium_checkout_events.findFirst({
        where: { eventType: 'CHECKOUT_VERIFIED', outcome: 'success' },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          amountMinor: true,
          currency: true,
          metadata: true,
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const activePremiumUsers = subscriptions.filter((subscription) =>
      isPremiumSubscriptionActive(subscription)
    ).length;
    const paidSubscriptions = subscriptions.filter(
      (subscription) =>
        isPremiumSubscriptionActive(subscription) &&
        ['razorpay', 'google_play'].includes(subscription.provider)
    );
    const activeRecurringRevenueMinor = paidSubscriptions.reduce(
      (total, subscription) => total + (subscription.amount || 0),
      0
    );
    const revenueMinor = paymentTotals._sum.amountMinor || 0;
    const revenueThisMonthMinor = paymentTotalsThisMonth._sum.amountMinor || 0;

    res.json({
      settings: {
        premiumDefaultAmountMinor: settings.premiumDefaultAmountMinor,
        premiumCurrency: settings.premiumCurrency,
        agentAvailabilityMode: normalizeAgentAvailabilityMode(settings.agentAvailabilityMode),
        premiumDisplayAmount: formatCurrency(
          settings.premiumDefaultAmountMinor,
          settings.premiumCurrency
        ),
      },
      stats: {
        activePremiumUsers,
        paidPremiumUsers: paidSubscriptions.length,
        customPriceUsers,
        agentSelectedUsers,
        profileCustomizationGrantedUsers,
        clickCount,
        failureCount,
        successCount,
        paymentCount: paymentTotals._count._all,
        paymentCountThisMonth: paymentTotalsThisMonth._count._all,
      },
      revenue: {
        currency: settings.premiumCurrency,
        totalMinor: revenueMinor,
        totalDisplay: formatCurrency(revenueMinor, settings.premiumCurrency),
        thisMonthMinor: revenueThisMonthMinor,
        thisMonthDisplay: formatCurrency(revenueThisMonthMinor, settings.premiumCurrency),
        activeRecurringMinor: activeRecurringRevenueMinor,
        activeRecurringDisplay: formatCurrency(
          activeRecurringRevenueMinor,
          settings.premiumCurrency
        ),
        lastPayment:
          lastPayment == null
            ? null
            : {
                createdAt: lastPayment.createdAt,
                amountMinor: lastPayment.amountMinor,
                currency: lastPayment.currency,
                displayAmount:
                  typeof lastPayment.amountMinor === 'number' && lastPayment.currency
                    ? formatCurrency(lastPayment.amountMinor, lastPayment.currency)
                    : null,
                user: lastPayment.user,
                ...buildEventPaymentRef(lastPayment.metadata),
              },
      },
    });
  } catch (error) {
    console.error('getPremiumAdminOverview error:', error);
    res.status(500).json({ error: 'Failed to load premium overview' });
  }
};

export const updatePremiumAdminSettings = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const premiumDefaultAmountMinor = parsePositiveInt(
      req.body?.premiumDefaultAmountMinor,
      19900
    );
    const premiumCurrency =
      typeof req.body?.premiumCurrency === 'string' && req.body.premiumCurrency.trim()
        ? req.body.premiumCurrency.trim().toUpperCase()
        : 'INR';
    const agentAvailabilityMode = normalizeAgentAvailabilityMode(req.body?.agentAvailabilityMode);

    const settings = await prisma.app_feature_settings.upsert({
      where: { id: 'default' },
      update: {
        premiumDefaultAmountMinor,
        premiumCurrency,
        agentAvailabilityMode,
      },
      create: {
        id: 'default',
        premiumDefaultAmountMinor,
        premiumCurrency,
        agentAvailabilityMode,
      },
    });

    res.json({
      message: 'Premium settings updated successfully',
      settings: {
        premiumDefaultAmountMinor: settings.premiumDefaultAmountMinor,
        premiumCurrency: settings.premiumCurrency,
        agentAvailabilityMode: normalizeAgentAvailabilityMode(settings.agentAvailabilityMode),
        premiumDisplayAmount: formatCurrency(
          settings.premiumDefaultAmountMinor,
          settings.premiumCurrency
        ),
      },
    });
  } catch (error) {
    console.error('updatePremiumAdminSettings error:', error);
    res.status(500).json({ error: 'Failed to update premium settings' });
  }
};
