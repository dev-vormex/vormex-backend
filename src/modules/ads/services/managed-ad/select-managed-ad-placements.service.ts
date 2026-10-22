import { randomUUID } from "crypto";
import { prisma, prismaRead } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { isCreatorProSubscriptionActive, isPremiumSubscriptionActive } from "../../../premium/services/premium-access.service";
import { TargetProfile, compactStrings, compactNumbers, startOfUtcDay, ManagedAdPlacementName, ManagedAdCampaignRecord, SelectManagedAdPlacementsInput, ManagedAdPlacement, managedAdSlotsForItemCount, campaignHasCreativeForPlacement, isManagedAdCtaAllowed, matchesManagedAdTargeting, hashScore, campaignToPlacement, TrackManagedAdEventInput } from "./managed-ad-feed-first-after-items.service";

async function loadTargetProfile(userId: string): Promise<TargetProfile | null> {
  const user = await prismaRead.user.findUnique({
    where: { id: userId },
    select: {
      college: true,
      branch: true,
      currentYear: true,
      graduationYear: true,
      interests: true,
      currentCity: true,
      currentState: true,
      currentCountry: true,
      currentCountryCode: true,
      isVerified: true,
      isOpenToOpportunities: true,
      subscriptions: {
        select: {
          plan: true,
          status: true,
          provider: true,
          currentPeriodEnd: true,
          cancelledAt: true,
        },
      },
      onboarding_profiles: {
        select: {
          primaryGoal: true,
          skillsToLearn: true,
          skillsToTeach: true,
          year: true,
          branch: true,
        },
      },
      skills: {
        select: {
          skill: { select: { name: true } },
        },
      },
    },
  });

  if (!user) return null;

  const isCreatorPro = isCreatorProSubscriptionActive(user.subscriptions);
  const isPremium = isPremiumSubscriptionActive(user.subscriptions);
  const premiumStates = isCreatorPro
    ? ['creator_pro', 'premium']
    : isPremium
      ? ['premium']
      : ['free'];

  return {
    colleges: compactStrings([user.college]),
    branches: compactStrings([user.branch, user.onboarding_profiles?.branch]),
    years: compactNumbers([user.currentYear, user.graduationYear, user.onboarding_profiles?.year]),
    currentYears: compactNumbers([user.currentYear, user.onboarding_profiles?.year]),
    graduationYears: compactNumbers([user.graduationYear]),
    interests: compactStrings(user.interests || []),
    skills: compactStrings([
      ...(user.skills || []).map((item: any) => item.skill?.name),
      ...(user.onboarding_profiles?.skillsToLearn || []),
      ...(user.onboarding_profiles?.skillsToTeach || []),
    ]),
    primaryGoals: compactStrings([user.onboarding_profiles?.primaryGoal]),
    cities: compactStrings([user.currentCity]),
    states: compactStrings([user.currentState]),
    countries: compactStrings([user.currentCountry]),
    countryCodes: compactStrings([user.currentCountryCode]),
    premiumStates,
    verification: [user.isVerified ? 'verified' : 'unverified'],
    openToOpportunities: [user.isOpenToOpportunities ? 'true' : 'false'],
  };
}

async function getTargetProfile(userId: string): Promise<TargetProfile | null> {
  return cacheService.getOrSet(
    `feed:managed-ads:profile:v1:user:${userId}`,
    () => loadTargetProfile(userId),
    {
      ttlSeconds: 60 * 60,
      tags: [`user:${userId}`, `feed:${userId}`],
    }
  );
}

async function dailyImpressionCounts(campaignIds: string[], userId: string, now: Date): Promise<Map<string, number>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await (prismaRead as any).managedAdEvent.groupBy({
    by: ['campaignId'],
    where: {
      campaignId: { in: campaignIds },
      userId,
      eventType: 'impression',
      createdAt: { gte: startOfUtcDay(now) },
    },
    _count: { _all: true },
  });

  return new Map(rows.map((row: any) => [row.campaignId, row._count?._all || 0]));
}

async function sessionImpressionCampaignIds(
  campaignIds: string[],
  placement: ManagedAdPlacementName,
  sessionId: string | null | undefined
): Promise<Set<string>> {
  if (!sessionId || campaignIds.length === 0) return new Set();
  const rows = await (prismaRead as any).managedAdEvent.findMany({
    where: {
      campaignId: { in: campaignIds },
      placement,
      sessionId,
      eventType: 'impression',
    },
    select: { campaignId: true },
  });
  return new Set(rows.map((row: any) => row.campaignId));
}

async function getActiveManagedAdCampaigns(
  placement: ManagedAdPlacementName,
  now: Date
): Promise<ManagedAdCampaignRecord[]> {
  const minuteWindow = Math.floor(now.getTime() / 60_000);
  return cacheService.getOrSet(
    `feed:managed-ads:campaigns:v1:${placement}:${minuteWindow}`,
    () => (prismaRead as any).managedAdCampaign.findMany({
      where: {
        status: 'active',
        placements: { has: placement },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    }),
    {
      ttlSeconds: 2 * 60,
      tags: ['managed-ads'],
    }
  );
}

export async function selectManagedAdPlacements(input: SelectManagedAdPlacementsInput): Promise<ManagedAdPlacement[]> {
  const userId = input.userId ? String(input.userId) : null;
  if (!userId) return [];

  const slots = managedAdSlotsForItemCount(input.placement, input.itemCount, input.itemOffset || 0);
  if (slots.length === 0) return [];

  const now = input.now || new Date();
  const [profile, campaigns] = await Promise.all([
    getTargetProfile(userId),
    getActiveManagedAdCampaigns(input.placement, now),
  ]);

  if (!profile || campaigns.length === 0) return [];

  const eligibleCampaigns = (campaigns as ManagedAdCampaignRecord[])
    .filter((campaign) => campaignHasCreativeForPlacement(campaign, input.placement))
    .filter((campaign) => isManagedAdCtaAllowed(campaign.ctaKind, campaign.ctaUrl))
    .filter((campaign) => matchesManagedAdTargeting(campaign.targeting, profile));

  if (eligibleCampaigns.length === 0) return [];

  const campaignIds = eligibleCampaigns.map((campaign) => campaign.id);
  const [impressionsByCampaign, sessionSeenCampaignIds] = await Promise.all([
    dailyImpressionCounts(campaignIds, userId, now),
    input.ignoreSessionHistory
      ? Promise.resolve(new Set<string>())
      : sessionImpressionCampaignIds(campaignIds, input.placement, input.sessionId),
  ]);

  const usedCampaignIds = new Set<string>();
  const placements: ManagedAdPlacement[] = [];

  slots.forEach((slot) => {
    const candidates = eligibleCampaigns
      .filter((campaign) => !usedCampaignIds.has(campaign.id))
      .filter((campaign) => {
        const cap = Math.max(1, Number(campaign.frequencyCapPerDay || 3));
        return (impressionsByCampaign.get(campaign.id) || 0) < cap;
      })
      .filter((campaign) => !sessionSeenCampaignIds.has(campaign.id))
      .sort((left, right) => {
        const priorityDelta = (right.priority || 0) - (left.priority || 0);
        if (priorityDelta !== 0) return priorityDelta;

        const impressionDelta =
          (impressionsByCampaign.get(left.id) || 0) -
          (impressionsByCampaign.get(right.id) || 0);
        if (impressionDelta !== 0) return impressionDelta;

        const leftHash = hashScore(`${userId}:${input.sessionId || 'default'}:${slot.slotKey}:${left.id}`);
        const rightHash = hashScore(`${userId}:${input.sessionId || 'default'}:${slot.slotKey}:${right.id}`);
        return leftHash - rightHash;
      });

    const selected = candidates[0];
    if (!selected) return;
    usedCampaignIds.add(selected.id);
    placements.push(campaignToPlacement(selected, slot));
  });

  return placements;
}

/**
 * Resolves the single creative for the feed sidebar rail, or null when no
 * campaign targets this viewer. Unlike the interleaved placements this is not
 * tied to how far the viewer has scrolled.
 */
export async function selectManagedAdSidebarPlacement(input: {
  userId?: string | null;
  sessionId?: string | null;
  now?: Date;
}): Promise<ManagedAdPlacement | null> {
  const placements = await selectManagedAdPlacements({
    userId: input.userId,
    placement: 'sidebar',
    itemCount: 1,
    sessionId: input.sessionId,
    now: input.now,
    ignoreSessionHistory: true,
  });
  return placements[0] || null;
}

export async function recordManagedAdEvent(input: TrackManagedAdEventInput): Promise<void> {
  const campaignId = String(input.campaignId || '').trim();
  const userId = input.userId ? String(input.userId) : null;
  if (!campaignId || !userId) return;

  const campaign = await (prismaRead as any).managedAdCampaign.findFirst({
    where: {
      id: campaignId,
      status: { not: 'archived' },
    },
    select: {
      id: true,
      placements: true,
    },
  });

  if (!campaign || !campaign.placements?.includes(input.placement)) return;

  if (input.eventType === 'impression' && input.sessionId && input.slotKey) {
    const existing = await (prismaRead as any).managedAdEvent.findFirst({
      where: {
        campaignId,
        userId,
        eventType: input.eventType,
        placement: input.placement,
        sessionId: input.sessionId,
        slotKey: input.slotKey,
      },
      select: { id: true },
    });
    if (existing) return;
  }

  await (prisma as any).managedAdEvent.create({
    data: {
      id: randomUUID(),
      campaignId,
      userId,
      eventType: input.eventType,
      placement: input.placement,
      slotKey: input.slotKey || null,
      sessionId: input.sessionId || null,
    },
  });

  await (prisma as any).managedAdCampaign.update({
    where: { id: campaignId },
    data: input.eventType === 'click'
      ? { clicksCount: { increment: 1 } }
      : { impressionsCount: { increment: 1 } },
  });
}

export function invalidateManagedAdCaches(): void {
  cacheService.invalidateTags('feed:global', 'reels:feed', 'managed-ads').catch(() => undefined);
}
