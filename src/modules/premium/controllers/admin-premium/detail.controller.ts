import { Response } from "express";
import { getPremiumAccessSnapshot, formatCurrency } from "../../services/premium-access.service";
import { prisma } from "../../../../config/prisma";
import { AuthRequest, buildEventPaymentRef } from "./support.controller";

export const getPremiumAdminUserDetail = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.params.id || '');
    if (!userId) {
      res.status(400).json({ error: 'User id is required' });
      return;
    }

    const [
      snapshot,
      user,
      agentMessagesAllTime,
      lastAgentMessage,
      premiumEventsCount,
      lastPremiumEvent,
      chatMessagesSent,
      conversationsCount,
      paymentEvents,
      paymentTotals,
    ] = await Promise.all([
        getPremiumAccessSnapshot(userId),
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            profileImage: true,
            createdAt: true,
            lastActiveAt: true,
            isOnline: true,
            college: true,
            branch: true,
            _count: {
              select: {
                posts: true,
                connections_connections_requesterIdTousers: true,
                connections_connections_addresseeIdTousers: true,
              },
            },
          },
        }),
        prisma.agent_messages.count({
          where: {
            userId,
            role: 'user',
          },
        }),
        prisma.agent_messages.findFirst({
          where: {
            userId,
            role: 'user',
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        prisma.premium_checkout_events.count({
          where: { userId },
        }),
        prisma.premium_checkout_events.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: {
            createdAt: true,
            eventType: true,
            outcome: true,
            message: true,
          },
        }),
        prisma.messages.count({
          where: {
            senderId: userId,
            isDeleted: false,
          },
        }),
        prisma.conversations.count({
          where: {
            OR: [{ participant1Id: userId }, { participant2Id: userId }],
          },
        }),
        prisma.premium_checkout_events.findMany({
          where: { userId, eventType: 'CHECKOUT_VERIFIED', outcome: 'success' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            createdAt: true,
            amountMinor: true,
            currency: true,
            metadata: true,
          },
        }),
        prisma.premium_checkout_events.aggregate({
          where: { userId, eventType: 'CHECKOUT_VERIFIED', outcome: 'success' },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
      ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const lifetimeValueMinor = paymentTotals._sum.amountMinor || 0;

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        profileImage: user.profileImage,
        createdAt: user.createdAt,
        lastActiveAt: user.lastActiveAt,
        isOnline: user.isOnline,
        college: user.college,
        branch: user.branch,
        postsCount: user._count.posts,
        connectionsCount:
          user._count.connections_connections_requesterIdTousers +
          user._count.connections_connections_addresseeIdTousers,
        isPremium: snapshot.isPremium,
        premiumStatus: snapshot.subscription?.status || 'inactive',
        premiumStartedAt: snapshot.premiumStartedAt,
        premiumEndsAt: snapshot.premiumEndsAt,
        premiumDaysRemaining: snapshot.premiumDaysRemaining,
        premiumPriceOverrideMinor: snapshot.override?.premiumPriceOverrideMinor ?? null,
        premiumDisplayAmount: snapshot.premiumDisplayAmount,
        agentEnabled: Boolean(snapshot.override?.agentEnabled),
        agentBlocked: Boolean(snapshot.override?.agentBlocked),
        canUseAgent: snapshot.canUseAgent,
        profileCustomizationGranted: Boolean(snapshot.override?.profileCustomizationGranted),
        profileCustomizationBlocked: Boolean(snapshot.override?.profileCustomizationBlocked),
        canAccessProfileCustomization: snapshot.canAccessProfileCustomization,
        canCancelPremium: snapshot.canCancelPremium,
        billing: {
          plan: snapshot.subscription?.plan || 'free',
          provider: snapshot.provider,
          billingCycle: snapshot.subscription?.billingCycle || null,
          amountMinor: snapshot.subscription?.amount ?? null,
          currency: snapshot.subscription?.currency || snapshot.premiumCurrency,
          amountDisplay:
            typeof snapshot.subscription?.amount === 'number'
              ? formatCurrency(
                  snapshot.subscription.amount,
                  snapshot.subscription.currency || snapshot.premiumCurrency
                )
              : null,
          autoPayEnabled: snapshot.autoPayEnabled,
          currentPeriodStart: snapshot.premiumStartedAt,
          currentPeriodEnd: snapshot.premiumEndsAt,
          lastProviderSyncAt: snapshot.subscription?.lastProviderSyncAt || null,
          googlePlayProductId: snapshot.subscription?.googlePlayProductId || null,
          paymentCount: paymentTotals._count._all,
          lifetimeValueMinor,
          lifetimeValueDisplay: formatCurrency(
            lifetimeValueMinor,
            snapshot.subscription?.currency || snapshot.premiumCurrency
          ),
          payments: paymentEvents.map((event) => ({
            id: event.id,
            createdAt: event.createdAt,
            amountMinor: event.amountMinor,
            currency: event.currency,
            displayAmount:
              typeof event.amountMinor === 'number' && event.currency
                ? formatCurrency(event.amountMinor, event.currency)
                : null,
            ...buildEventPaymentRef(event.metadata),
          })),
        },
        usage: {
          creditsUsedCurrentCycle: snapshot.creditsUsed,
          agentMessagesAllTime,
          chatMessagesSent,
          conversationsCount,
          premiumEventsCount,
          lastAgentMessageAt: lastAgentMessage?.createdAt || null,
          lastPremiumEvent:
            lastPremiumEvent == null
              ? null
              : {
                  createdAt: lastPremiumEvent.createdAt,
                  eventType: lastPremiumEvent.eventType,
                  outcome: lastPremiumEvent.outcome,
                  message: lastPremiumEvent.message,
                },
        },
      },
    });
  } catch (error) {
    console.error('getPremiumAdminUserDetail error:', error);
    res.status(500).json({ error: 'Failed to load premium user detail' });
  }
};
