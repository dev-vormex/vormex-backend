import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import {
  cancelPremiumSubscription,
  evaluateAgentAccess,
  formatCurrency,
  getPremiumDaysRemaining,
  getPremiumDurationDays,
  getOrCreateAppFeatureSettings,
  getPremiumAccessSnapshot,
  getPremiumPeriodEnd,
  isPremiumSubscriptionActive,
  logPremiumCheckoutEvent,
  normalizeAgentAvailabilityMode,
} from '../services/premium-access.service';
import { getIO } from '../sockets';
import { pushNotificationService } from '../services/push-notification.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

type PremiumUsersFilter = 'all' | 'premium' | 'overrides';
type PremiumEventsFilter = 'all' | 'clicked' | 'failed' | 'success';

const chatUserSelect = {
  id: true,
  username: true,
  name: true,
  profileImage: true,
  isOnline: true,
  lastActiveAt: true,
};

const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

const normalizeSearch = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const mapEventFilterToWhere = (filter: PremiumEventsFilter) => {
  if (filter === 'clicked') {
    return { eventType: 'CLICKED_GET_PREMIUM' };
  }
  if (filter === 'failed') {
    return { outcome: 'failure' };
  }
  if (filter === 'success') {
    return { outcome: 'success' };
  }
  return {};
};

async function getOrCreateConversationForUsers(userId: string, otherUserId: string) {
  let conversation = await prisma.conversations.findFirst({
    where: {
      OR: [
        { participant1Id: userId, participant2Id: otherUserId },
        { participant1Id: otherUserId, participant2Id: userId },
      ],
    },
  });

  if (!conversation) {
    conversation = await prisma.conversations.create({
      data: {
        id: randomUUID(),
        participant1Id: userId,
        participant2Id: otherUserId,
      },
    });
  }

  return conversation;
}

function buildChatMessagePayload(message: any, sender: any) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    receiverId: message.receiverId,
    content: message.content,
    contentType: message.contentType,
    mediaUrl: message.mediaUrl,
    mediaType: message.mediaType,
    fileName: message.fileName,
    fileSize: message.fileSize,
    status: message.status,
    deliveredAt: message.deliveredAt?.toISOString() || null,
    readAt: message.readAt?.toISOString() || null,
    isDeleted: message.isDeleted,
    replyToId: message.replyToId,
    replyTo: message.messages || null,
    sender,
    reactions: [],
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

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
    const [
      subscriptions,
      customPriceUsers,
      agentSelectedUsers,
      profileCustomizationGrantedUsers,
      clickCount,
      failureCount,
      successCount,
    ] = await Promise.all([
      prisma.subscriptions.findMany({
        select: {
          plan: true,
          status: true,
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
    ]);

    const activePremiumUsers = subscriptions.filter((subscription) =>
      isPremiumSubscriptionActive(subscription)
    ).length;

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
        customPriceUsers,
        agentSelectedUsers,
        profileCustomizationGrantedUsers,
        clickCount,
        failureCount,
        successCount,
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
              amount: true,
              currency: true,
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

    res.json({
      users: await Promise.all(users.map(async (user) => {
        const isPremium = isPremiumSubscriptionActive(user.subscriptions);
        const premiumAmountMinor =
          user.featureAccessOverride?.premiumPriceOverrideMinor ??
          settings.premiumDefaultAmountMinor;
        const premiumEndsAt =
          user.subscriptions?.currentPeriodEnd ||
          (user.subscriptions?.currentPeriodStart
            ? getPremiumPeriodEnd(user.subscriptions.currentPeriodStart)
            : null);
        const creditsWindowStart =
          user.subscriptions?.currentPeriodStart ||
          new Date(Date.now() - getPremiumDurationDays() * 24 * 60 * 60 * 1000);
        const creditsUsed = await prisma.agent_messages.count({
          where: {
            userId: user.id,
            role: 'user',
            createdAt: {
              gte: creditsWindowStart,
            },
          },
        });
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
      })),
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

export const updatePremiumAdminUser = async (
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hasExplicitPremiumOverride =
      req.body?.premiumPriceOverrideMinor !== undefined &&
      req.body?.premiumPriceOverrideMinor !== null &&
      String(req.body?.premiumPriceOverrideMinor).trim() !== '';
    const premiumPriceOverrideMinor = hasExplicitPremiumOverride
      ? parsePositiveInt(req.body?.premiumPriceOverrideMinor, 0)
      : null;
    const agentEnabled = Boolean(req.body?.agentEnabled);
    const agentBlocked = Boolean(req.body?.agentBlocked);
    const profileCustomizationGranted = Boolean(req.body?.profileCustomizationGranted);
    const profileCustomizationBlocked = Boolean(req.body?.profileCustomizationBlocked);

    if (
      !hasExplicitPremiumOverride &&
      !agentEnabled &&
      !agentBlocked &&
      !profileCustomizationGranted &&
      !profileCustomizationBlocked
    ) {
      await prisma.user_feature_access_overrides.deleteMany({
        where: { userId },
      });
    } else {
      await prisma.user_feature_access_overrides.upsert({
        where: { userId },
        update: {
          premiumPriceOverrideMinor:
            hasExplicitPremiumOverride && premiumPriceOverrideMinor > 0
              ? premiumPriceOverrideMinor
              : null,
          agentEnabled,
          agentBlocked,
          profileCustomizationGranted,
          profileCustomizationBlocked,
        },
        create: {
          userId,
          premiumPriceOverrideMinor:
            hasExplicitPremiumOverride && premiumPriceOverrideMinor > 0
              ? premiumPriceOverrideMinor
              : null,
          agentEnabled,
          agentBlocked,
          profileCustomizationGranted,
          profileCustomizationBlocked,
        },
      });
    }

    const snapshot = await getPremiumAccessSnapshot(userId);

    res.json({
      message: 'Premium user access updated successfully',
      user: {
        id: userId,
        premiumPriceOverrideMinor: snapshot.override?.premiumPriceOverrideMinor ?? null,
        agentEnabled: Boolean(snapshot.override?.agentEnabled),
        agentBlocked: Boolean(snapshot.override?.agentBlocked),
        profileCustomizationGranted: Boolean(snapshot.override?.profileCustomizationGranted),
        profileCustomizationBlocked: Boolean(snapshot.override?.profileCustomizationBlocked),
        canUseAgent: snapshot.canUseAgent,
        canAccessProfileCustomization: snapshot.canAccessProfileCustomization,
        premiumDisplayAmount: snapshot.premiumDisplayAmount,
      },
    });
  } catch (error) {
    console.error('updatePremiumAdminUser error:', error);
    res.status(500).json({ error: 'Failed to update premium user access' });
  }
};

export const cancelPremiumAdminUser = async (
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

    const snapshot = await getPremiumAccessSnapshot(userId);
    if (!snapshot.subscription || !snapshot.isPremium) {
      res.status(409).json({ error: 'This user does not have an active premium plan.' });
      return;
    }

    await cancelPremiumSubscription(userId, 'admin');
    await prisma.user_feature_access_overrides.upsert({
      where: { userId },
      update: {
        premiumPriceOverrideMinor: null,
        agentEnabled: false,
        agentBlocked: true,
        profileCustomizationGranted: false,
        profileCustomizationBlocked: true,
      },
      create: {
        userId,
        premiumPriceOverrideMinor: null,
        agentEnabled: false,
        agentBlocked: true,
        profileCustomizationGranted: false,
        profileCustomizationBlocked: true,
      },
    });
    await logPremiumCheckoutEvent({
      userId,
      eventType: 'ADMIN_CANCELLED_SUBSCRIPTION',
      outcome: 'success',
      message: `Premium access revoked by admin ${req.user.userId}.`,
      amountMinor: snapshot.premiumAmountMinor,
      currency: snapshot.premiumCurrency,
      metadata: {
        adminUserId: req.user.userId,
      },
    });

    const updatedSnapshot = await getPremiumAccessSnapshot(userId);
    res.json({
      message: 'Premium access cancelled for this user.',
      user: {
        id: userId,
        isPremium: updatedSnapshot.isPremium,
        premiumStatus: updatedSnapshot.subscription?.status || 'inactive',
        premiumEndsAt: updatedSnapshot.premiumEndsAt,
        premiumDaysRemaining: updatedSnapshot.premiumDaysRemaining,
        canUseAgent: updatedSnapshot.canUseAgent,
        canAccessProfileCustomization: updatedSnapshot.canAccessProfileCustomization,
      },
    });
  } catch (error) {
    console.error('cancelPremiumAdminUser error:', error);
    res.status(500).json({ error: 'Failed to cancel premium access for this user' });
  }
};

export const getPremiumAdminEvents = async (
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
    const filter = String(req.query.filter || 'all') as PremiumEventsFilter;
    const search = normalizeSearch(req.query.search);
    const skip = (page - 1) * limit;

    const where: any = {
      ...mapEventFilterToWhere(filter),
    };

    if (search) {
      where.OR = [
        {
          message: {
            contains: search,
            mode: 'insensitive',
          },
        },
        {
          user: {
            is: {
              name: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        },
        {
          user: {
            is: {
              email: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        },
        {
          user: {
            is: {
              username: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        },
      ];
    }

    const [events, total] = await Promise.all([
      prisma.premium_checkout_events.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          eventType: true,
          outcome: true,
          message: true,
          amountMinor: true,
          currency: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              username: true,
            },
          },
        },
      }),
      prisma.premium_checkout_events.count({ where }),
    ]);

    res.json({
      events: events.map((event) => ({
        ...event,
        displayAmount:
          typeof event.amountMinor === 'number' && event.currency
            ? formatCurrency(event.amountMinor, event.currency)
            : null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getPremiumAdminEvents error:', error);
    res.status(500).json({ error: 'Failed to load premium events' });
  }
};

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

    const [snapshot, user, agentMessagesAllTime, lastAgentMessage, premiumEventsCount, lastPremiumEvent, chatMessagesSent, conversationsCount] =
      await Promise.all([
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
      ]);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

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

export const sendPremiumAdminUserMessage = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const adminId = req.user?.userId;
    if (!adminId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.params.id || '');
    if (!userId) {
      res.status(400).json({ error: 'User id is required' });
      return;
    }

    const content =
      typeof req.body?.message === 'string' ? req.body.message.trim() : '';

    if (!content) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (content.length > 1000) {
      res.status(400).json({ error: 'Message must be 1000 characters or less' });
      return;
    }

    const [targetUser, sender] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, isBanned: true },
      }),
      prisma.user.findUnique({
        where: { id: adminId },
        select: chatUserSelect,
      }),
    ]);

    if (!targetUser || targetUser.isBanned) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const conversation = await getOrCreateConversationForUsers(adminId, userId);
    const message = await prisma.messages.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        senderId: adminId,
        receiverId: userId,
        content,
        contentType: 'text',
        status: 'SENT',
        updatedAt: new Date(),
      },
      include: {
        messages: {
          select: {
            id: true,
            content: true,
            contentType: true,
            senderId: true,
          },
        },
      },
    });

    await prisma.conversations.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const messagePayload = buildChatMessagePayload(message, sender);
    const io = getIO();

    if (io) {
      io.to(`chat:${conversation.id}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });
      io.to(`user:${adminId}`).emit('chat:new_message', {
        conversationId: conversation.id,
        message: messagePayload,
      });
      io.to(`user:${userId}`).emit('chat:notification', {
        type: 'new_message',
        conversationId: conversation.id,
        message: messagePayload,
        sender,
      });
    }

    if (sender) {
      const preview =
        content.length > 100 ? `${content.slice(0, 97)}...` : content;
      pushNotificationService
        .pushNewMessage(
          userId,
          sender.name || sender.username || 'Admin',
          preview,
          conversation.id,
          adminId,
          sender.profileImage || undefined
        )
        .catch(console.error);
    }

    res.status(201).json({
      message: 'Admin message sent successfully',
      conversationId: conversation.id,
      directMessage: messagePayload,
    });
  } catch (error) {
    console.error('sendPremiumAdminUserMessage error:', error);
    res.status(500).json({ error: 'Failed to send admin message' });
  }
};
