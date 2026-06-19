// @ts-nocheck
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { socialProofService } from './social-proof.service';
import {
  formatCurrency,
  getCreatorProDescription,
  getCreatorProFeatureLabels,
  getCreatorProPlan,
  getCreatorProPlanOptions,
  getCreatorProTitle,
  getPremiumAccessSnapshot,
} from './premium-access.service';

export type CreatorProSettingsPatch = {
  monetizedDmEnabled?: unknown;
  dmPriceMinor?: unknown;
  sessionBookingEnabled?: unknown;
  sessionPriceMinor?: unknown;
  sessionDurationMinutes?: unknown;
  sessionCurrency?: unknown;
  collabPriorityEnabled?: unknown;
  showcaseAmplificationEnabled?: unknown;
  portfolioAmplificationEnabled?: unknown;
  availabilityNote?: unknown;
};

const DEFAULT_CREATOR_PRO_CURRENCY = 'INR';
const DEFAULT_SESSION_DURATION_MINUTES = 30;
const MIN_SESSION_DURATION_MINUTES = 15;
const MAX_SESSION_DURATION_MINUTES = 180;
const MAX_PRICE_MINOR = 500000;

function readFeeBps() {
  const raw = Number(process.env.VORMEX_CREATOR_PRO_PLATFORM_FEE_BPS || 1000);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), 0), 5000) : 1000;
}

function toBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function toMinor(value: unknown, fallback: number) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return fallback;
  return Math.min(Math.max(Math.round(amount), 0), MAX_PRICE_MINOR);
}

function toDuration(value: unknown, fallback: number) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return fallback;
  return Math.min(
    Math.max(Math.round(duration), MIN_SESSION_DURATION_MINUTES),
    MAX_SESSION_DURATION_MINUTES
  );
}

function toCurrency(value: unknown, fallback = DEFAULT_CREATOR_PRO_CURRENCY) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function toNullableNote(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.slice(0, 180);
}

function platformFee(amountMinor: number) {
  const feeBps = readFeeBps();
  const platformFeeMinor = Math.round((Math.max(amountMinor, 0) * feeBps) / 10000);
  return {
    platformFeeBps: feeBps,
    platformFeeMinor,
    creatorReceivesMinor: Math.max(amountMinor - platformFeeMinor, 0),
  };
}

function serializeSettings(settings: any) {
  const currency = toCurrency(settings?.sessionCurrency);
  const dmFee = platformFee(settings?.dmPriceMinor || 0);
  const sessionFee = platformFee(settings?.sessionPriceMinor || 0);

  return {
    monetizedDmEnabled: Boolean(settings?.monetizedDmEnabled),
    dmPriceMinor: settings?.dmPriceMinor || 0,
    dmDisplayPrice: formatCurrency(settings?.dmPriceMinor || 0, currency),
    dmPlatformFeeMinor: dmFee.platformFeeMinor,
    dmCreatorReceivesMinor: dmFee.creatorReceivesMinor,
    dmCreatorReceivesDisplay: formatCurrency(dmFee.creatorReceivesMinor, currency),
    sessionBookingEnabled: Boolean(settings?.sessionBookingEnabled),
    sessionPriceMinor: settings?.sessionPriceMinor || 0,
    sessionDisplayPrice: formatCurrency(settings?.sessionPriceMinor || 0, currency),
    sessionDurationMinutes: settings?.sessionDurationMinutes || DEFAULT_SESSION_DURATION_MINUTES,
    sessionCurrency: currency,
    sessionPlatformFeeMinor: sessionFee.platformFeeMinor,
    sessionCreatorReceivesMinor: sessionFee.creatorReceivesMinor,
    sessionCreatorReceivesDisplay: formatCurrency(sessionFee.creatorReceivesMinor, currency),
    platformFeeBps: sessionFee.platformFeeBps,
    collabPriorityEnabled: settings?.collabPriorityEnabled !== false,
    showcaseAmplificationEnabled: settings?.showcaseAmplificationEnabled !== false,
    portfolioAmplificationEnabled: settings?.portfolioAmplificationEnabled !== false,
    availabilityNote: settings?.availabilityNote || null,
    updatedAt: settings?.updatedAt?.toISOString?.() || null,
  };
}

function buildSettingsData(userId: string, patch: CreatorProSettingsPatch = {}, current?: any) {
  const data: any = {
    userId,
    monetizedDmEnabled: toBoolean(patch.monetizedDmEnabled, Boolean(current?.monetizedDmEnabled)),
    dmPriceMinor: toMinor(patch.dmPriceMinor, current?.dmPriceMinor || 0),
    sessionBookingEnabled: toBoolean(
      patch.sessionBookingEnabled,
      Boolean(current?.sessionBookingEnabled)
    ),
    sessionPriceMinor: toMinor(patch.sessionPriceMinor, current?.sessionPriceMinor || 0),
    sessionDurationMinutes: toDuration(
      patch.sessionDurationMinutes,
      current?.sessionDurationMinutes || DEFAULT_SESSION_DURATION_MINUTES
    ),
    sessionCurrency: toCurrency(patch.sessionCurrency, current?.sessionCurrency || DEFAULT_CREATOR_PRO_CURRENCY),
    collabPriorityEnabled: toBoolean(
      patch.collabPriorityEnabled,
      current?.collabPriorityEnabled !== false
    ),
    showcaseAmplificationEnabled: toBoolean(
      patch.showcaseAmplificationEnabled,
      current?.showcaseAmplificationEnabled !== false
    ),
    portfolioAmplificationEnabled: toBoolean(
      patch.portfolioAmplificationEnabled,
      current?.portfolioAmplificationEnabled !== false
    ),
  };

  const note = toNullableNote(patch.availabilityNote);
  if (note !== undefined) data.availabilityNote = note;
  return data;
}

export async function getOrCreateCreatorProSettings(userId: string) {
  const existing = await prisma.creator_pro_settings.findUnique({ where: { userId } });
  if (existing) return existing;

  return prisma.creator_pro_settings.create({
    data: {
      id: randomUUID(),
      userId,
      sessionCurrency: DEFAULT_CREATOR_PRO_CURRENCY,
    },
  });
}

async function getCreatorContentStats(userId: string) {
  const [reelStats, postStats, collaborationInvites, acceptedCollaborations] = await Promise.all([
    prisma.reels.aggregate({
      where: { authorId: userId, status: 'ready' },
      _count: true,
      _sum: {
        viewsCount: true,
        likesCount: true,
        commentsCount: true,
        sharesCount: true,
        savesCount: true,
      },
      _avg: {
        avgWatchTimeMs: true,
        completionRate: true,
      },
    }),
    prisma.post.aggregate({
      where: { authorId: userId, isActive: true },
      _count: true,
      _sum: {
        likesCount: true,
        commentsCount: true,
        sharesCount: true,
      },
    }),
    (prisma as any).postCollaborator.count({
      where: {
        OR: [{ userId }, { invitedById: userId }],
      },
    }),
    (prisma as any).postCollaborator.count({
      where: {
        status: 'accepted',
        OR: [{ userId }, { invitedById: userId }],
      },
    }),
  ]);

  return {
    reels: {
      count: reelStats._count || 0,
      views: reelStats._sum.viewsCount || 0,
      likes: reelStats._sum.likesCount || 0,
      comments: reelStats._sum.commentsCount || 0,
      shares: reelStats._sum.sharesCount || 0,
      saves: reelStats._sum.savesCount || 0,
      averageWatchTimeMs: Math.round(reelStats._avg.avgWatchTimeMs || 0),
      completionRate: Math.round((reelStats._avg.completionRate || 0) * 10) / 10,
    },
    posts: {
      count: postStats._count || 0,
      likes: postStats._sum.likesCount || 0,
      comments: postStats._sum.commentsCount || 0,
      shares: postStats._sum.sharesCount || 0,
    },
    collaborations: {
      totalInvites: collaborationInvites,
      accepted: acceptedCollaborations,
    },
  };
}

async function getCreatorProAnalytics(userId: string, settings: any) {
  const [insights, content] = await Promise.all([
    socialProofService.getProfileInsights(userId),
    getCreatorContentStats(userId),
  ]);
  const profile = insights.analytics;

  return {
    audience: {
      profileViewsTotal: profile.views.total,
      profileViewsLast7Days: profile.views.last7Days,
      profileViewsLast30Days: profile.views.last30Days,
      uniqueViewers: profile.views.unique,
      profileSavesTotal: profile.profileSaves.total,
      profileSavesLast30Days: profile.profileSaves.last30Days,
      searchAppearancesLast30Days: profile.searchAppearances.last30Days,
      suggestionAppearancesLast30Days: profile.suggestionAppearances.last30Days,
      matchRateDisplay: profile.matchRate.display,
      connectionRequestsLast30Days: profile.matchRate.connectionRequests,
      acceptedConnectionsLast30Days: profile.matchRate.acceptedConnections,
    },
    collab: {
      priorityEnabled: settings.collabPriorityEnabled !== false,
      totalInvites: content.collaborations.totalInvites,
      accepted: content.collaborations.accepted,
      acceptanceRate:
        content.collaborations.totalInvites > 0
          ? Math.round((content.collaborations.accepted / content.collaborations.totalInvites) * 1000) / 10
          : 0,
    },
    content,
    monetization: {
      dmEnabled: Boolean(settings.monetizedDmEnabled),
      sessionEnabled: Boolean(settings.sessionBookingEnabled),
      currency: toCurrency(settings.sessionCurrency),
      dmPriceMinor: settings.dmPriceMinor || 0,
      sessionPriceMinor: settings.sessionPriceMinor || 0,
      platformFeeBps: readFeeBps(),
    },
    showcase: {
      showcaseAmplificationEnabled: settings.showcaseAmplificationEnabled !== false,
      portfolioAmplificationEnabled: settings.portfolioAmplificationEnabled !== false,
      topTags: insights.matchInsights.topTags,
      reasons: insights.matchInsights.reasons,
    },
  };
}

export async function getCreatorProState(userId: string) {
  const [snapshot, settings] = await Promise.all([
    getPremiumAccessSnapshot(userId),
    getOrCreateCreatorProSettings(userId),
  ]);
  const canUseCreatorPro = snapshot.isCreatorPro || snapshot.user.isAdmin;
  const analytics = canUseCreatorPro
    ? await getCreatorProAnalytics(userId, settings)
    : null;

  return {
    access: {
      plan: getCreatorProPlan(),
      isCreatorPro: snapshot.isCreatorPro,
      isPremium: snapshot.isPremium,
      canUseCreatorPro,
      premiumRequired: !canUseCreatorPro,
      title: getCreatorProTitle(),
      description: getCreatorProDescription(),
      features: getCreatorProFeatureLabels(),
      planOptions: getCreatorProPlanOptions(snapshot.premiumCurrency),
    },
    settings: serializeSettings(settings),
    analytics,
  };
}

export async function updateCreatorProSettings(userId: string, patch: CreatorProSettingsPatch) {
  const snapshot = await getPremiumAccessSnapshot(userId);
  if (!snapshot.isCreatorPro && !snapshot.user.isAdmin) {
    return {
      ok: false,
      statusCode: 402,
      code: 'creator_pro_required',
      error: 'Creator Pro is required to manage creator monetization and amplification settings.',
    };
  }

  const current = await getOrCreateCreatorProSettings(userId);
  const data = buildSettingsData(userId, patch, current);
  await prisma.creator_pro_settings.upsert({
    where: { userId },
    create: {
      id: randomUUID(),
      ...data,
    },
    update: data,
  });

  return {
    ok: true,
    state: await getCreatorProState(userId),
  };
}
