import { Response } from "express";
import { getOrCreateAppFeatureSettings, normalizeAgentAvailabilityMode, getPremiumDurationDays, isPremiumSubscriptionActive, getPremiumPeriodEnd, evaluateAgentAccess, formatCurrency, getPremiumDaysRemaining } from "../../services/premium-access.service";
import { prisma } from "../../../../config/prisma";
import { AuthRequest, parsePositiveInt, PremiumUsersFilter, normalizeSearch } from "./support.controller";

export const getPremiumAdminUsers = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 20);
    const filter = String(req.query.filter || 'all') as PremiumUsersFilter;
    const search = normalizeSearch(req.query.search);
    const skip = (page - 1) * limit;
    const settings = await getOrCreateAppFeatureSettings();
    const agentMode = normalizeAgentAvailabilityMode(settings.agentAvailabilityMode);

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { username: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (filter === 'premium') {
      where.subscriptions = {
        is: {
          plan: 'premium',
          status: {
            in: ['active', 'captured', 'authorized'],
          },
        },
      };
    } else if (filter === 'overrides') {
      where.featureAccessOverride = {
        is: {
          OR: [
            { premiumPriceOverrideMinor: { not: null } },
            { agentEnabled: true },
            { agentBlocked: true },
            { profileCustomizationGranted: true },
            { profileCustomizationBlocked: true },
          ],
        },
      };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          profileImage: true,
          isAdmin: true,
          createdAt: true,
          subscriptions: {
            select: {
              plan: true,
              status: true,
              provider: true,
              amount: true,
              currency: true,
              billingCycle: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              cancelledAt: true,
            },
          },
          featureAccessOverride: {
            select: {
              premiumPriceOverrideMinor: true,
              agentEnabled: true,
              agentBlocked: true,
              profileCustomizationGranted: true,
              profileCustomizationBlocked: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const defaultCreditsWindowStart = new Date(
      Date.now() - getPremiumDurationDays() * 24 * 60 * 60 * 1000
    );
    const creditsWindowStartByUserId = new Map(
      users.map((user) => [
        user.id,
        user.subscriptions?.currentPeriodStart || defaultCreditsWindowStart,
      ])
    );
    const creditCountRows =
      users.length > 0
        ? await prisma.agent_messages.groupBy({
            by: ['userId'],
            where: {
              role: 'user',
              OR: users.map((user) => ({
                userId: user.id,
                createdAt: {
                  gte: creditsWindowStartByUserId.get(user.id)!,
                },
              })),
            },
            _count: {
              _all: true,
            },
          })
        : [];
    const creditsUsedByUserId = new Map(
      creditCountRows.map((row) => [row.userId, row._count._all])
    );

    res.json({
      users: users.map((user) => {
        const isPremium = isPremiumSubscriptionActive(user.subscriptions);
        const premiumAmountMinor =
          user.featureAccessOverride?.premiumPriceOverrideMinor ??
          settings.premiumDefaultAmountMinor;
        const premiumEndsAt =
          user.subscriptions?.currentPeriodEnd ||
          (user.subscriptions?.currentPeriodStart
            ? getPremiumPeriodEnd(user.subscriptions.currentPeriodStart)
            : null);
        const creditsUsed = creditsUsedByUserId.get(user.id) || 0;
        const agentAccess = evaluateAgentAccess({
          isAdmin: user.isAdmin,
          isPremium,
          agentMode,
          agentEnabled: Boolean(user.featureAccessOverride?.agentEnabled),
          agentBlocked: Boolean(user.featureAccessOverride?.agentBlocked),
          creditsUsed,
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          username: user.username,
          profileImage: user.profileImage,
          createdAt: user.createdAt,
          isPremium,
          premiumStatus: user.subscriptions?.status || 'inactive',
          premiumPlan: user.subscriptions?.plan || 'free',
          premiumProvider: user.subscriptions?.provider || null,
          premiumBillingCycle: user.subscriptions?.billingCycle || null,
          premiumPaidAmountDisplay:
            typeof user.subscriptions?.amount === 'number'
              ? formatCurrency(
                  user.subscriptions.amount,
                  user.subscriptions.currency || settings.premiumCurrency
                )
              : null,
          premiumStartedAt: user.subscriptions?.currentPeriodStart || null,
          premiumEndsAt,
          premiumDaysRemaining: isPremium ? getPremiumDaysRemaining(premiumEndsAt) : 0,
          premiumPriceOverrideMinor: user.featureAccessOverride?.premiumPriceOverrideMinor ?? null,
          premiumDisplayAmount: formatCurrency(premiumAmountMinor, settings.premiumCurrency),
          agentEnabled: Boolean(user.featureAccessOverride?.agentEnabled),
          agentBlocked: Boolean(user.featureAccessOverride?.agentBlocked),
          canUseAgent: agentAccess.canUseAgent,
          profileCustomizationGranted: Boolean(
            user.featureAccessOverride?.profileCustomizationGranted
          ),
          profileCustomizationBlocked: Boolean(
            user.featureAccessOverride?.profileCustomizationBlocked
          ),
          canAccessProfileCustomization:
            user.isAdmin ||
            (!user.featureAccessOverride?.profileCustomizationBlocked &&
              (isPremium || Boolean(user.featureAccessOverride?.profileCustomizationGranted))),
          creditsUsed,
          canCancelPremium: isPremium,
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getPremiumAdminUsers error:', error);
    res.status(500).json({ error: 'Failed to load premium users' });
  }
};
