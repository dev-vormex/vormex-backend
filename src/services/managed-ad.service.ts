import { createHash, randomUUID } from 'crypto';
import { prisma, prismaRead } from '../config/prisma';
import { cacheService } from './cache.service';
import {
  isCreatorProSubscriptionActive,
  isPremiumSubscriptionActive,
} from './premium-access.service';

export type ManagedAdPlacementName = 'feed' | 'reels';
export type ManagedAdEventType = 'impression' | 'click';

export const MANAGED_AD_FEED_FIRST_AFTER_ITEMS = 4;
export const MANAGED_AD_FEED_INTERVAL_ITEMS = 8;
export const MANAGED_AD_REELS_FIRST_AFTER_ITEMS = 5;
export const MANAGED_AD_REELS_INTERVAL_ITEMS = 8;

export interface ManagedAdSlot {
  placement: ManagedAdPlacementName;
  sequence: number;
  afterItemCount: number;
  slotKey: string;
}

export interface ManagedAdPlacement {
  placement: ManagedAdPlacementName;
  sequence: number;
  afterItemCount: number;
  slotKey: string;
  campaignId: string;
  sponsorName: string;
  ctaText: string | null;
  ctaKind: string | null;
  ctaUrl: string | null;
  feedTitle: string | null;
  feedBody: string | null;
  feedImageUrl: string | null;
  reelCaption: string | null;
  reelsVideoUrl: string | null;
  reelsHlsUrl: string | null;
  reelsThumbnailUrl: string | null;
}

type TargetingBlock = Record<string, unknown>;

export interface ManagedAdTargeting {
  include?: TargetingBlock;
  exclude?: TargetingBlock;
}

interface SelectManagedAdPlacementsInput {
  userId?: string | null;
  placement: ManagedAdPlacementName;
  itemCount: number;
  itemOffset?: number | null;
  sessionId?: string | null;
  now?: Date;
}

interface TrackManagedAdEventInput {
  campaignId: string;
  userId?: string | null;
  eventType: ManagedAdEventType;
  placement: ManagedAdPlacementName;
  slotKey?: string | null;
  sessionId?: string | null;
}

type ManagedAdCampaignRecord = {
  id: string;
  sponsorName: string;
  placements: string[];
  priority: number;
  frequencyCapPerDay: number;
  targeting: unknown;
  ctaText: string | null;
  ctaKind: string | null;
  ctaUrl: string | null;
  feedTitle: string | null;
  feedBody: string | null;
  feedImageUrl: string | null;
  reelCaption: string | null;
  reelsVideoUrl: string | null;
  reelsHlsUrl: string | null;
  reelsThumbnailUrl: string | null;
};

type TargetProfile = {
  colleges: string[];
  branches: string[];
  years: number[];
  currentYears: number[];
  graduationYears: number[];
  interests: string[];
  skills: string[];
  primaryGoals: string[];
  cities: string[];
  states: string[];
  countries: string[];
  countryCodes: string[];
  premiumStates: string[];
  verification: string[];
  openToOpportunities: string[];
};

const WEB_HOSTS = new Set(['vormex.in', 'www.vormex.in', 'vormex.com', 'www.vormex.com']);

function normalizeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

function compactStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map(normalizeString)
        .filter((value): value is string => Boolean(value))
    )
  );
}

function compactNumbers(values: unknown[]): number[] {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.round(value))
    )
  );
}

function valuesFromBlock(block: TargetingBlock | undefined, key: string): unknown[] {
  if (!block || block[key] === undefined || block[key] === null) return [];
  return Array.isArray(block[key]) ? block[key] as unknown[] : [block[key]];
}

function textTargets(block: TargetingBlock | undefined, key: string): string[] {
  return compactStrings(valuesFromBlock(block, key));
}

function numberTargets(block: TargetingBlock | undefined, key: string): number[] {
  return compactNumbers(valuesFromBlock(block, key));
}

function booleanTargets(block: TargetingBlock | undefined, key: string): string[] {
  return valuesFromBlock(block, key)
    .map((value) => {
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      const normalized = normalizeString(value);
      if (normalized === 'yes' || normalized === '1') return 'true';
      if (normalized === 'no' || normalized === '0') return 'false';
      return normalized;
    })
    .filter((value): value is string => value === 'true' || value === 'false');
}

function hasAny(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const leftSet = new Set(left);
  return right.some((item) => leftSet.has(item));
}

function hasAnyNumber(left: number[], right: number[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const leftSet = new Set(left);
  return right.some((item) => leftSet.has(item));
}

function matchesTextDimension(
  profileValues: string[],
  includeBlock: TargetingBlock | undefined,
  excludeBlock: TargetingBlock | undefined,
  key: string
): boolean {
  const includes = textTargets(includeBlock, key);
  const excludes = textTargets(excludeBlock, key);
  if (hasAny(profileValues, excludes)) return false;
  if (includes.length === 0) return true;
  return hasAny(profileValues, includes);
}

function matchesNumberDimension(
  profileValues: number[],
  includeBlock: TargetingBlock | undefined,
  excludeBlock: TargetingBlock | undefined,
  key: string
): boolean {
  const includes = numberTargets(includeBlock, key);
  const excludes = numberTargets(excludeBlock, key);
  if (hasAnyNumber(profileValues, excludes)) return false;
  if (includes.length === 0) return true;
  return hasAnyNumber(profileValues, includes);
}

function matchesBooleanDimension(
  profileValues: string[],
  includeBlock: TargetingBlock | undefined,
  excludeBlock: TargetingBlock | undefined,
  key: string
): boolean {
  const includes = booleanTargets(includeBlock, key);
  const excludes = booleanTargets(excludeBlock, key);
  if (hasAny(profileValues, excludes)) return false;
  if (includes.length === 0) return true;
  return hasAny(profileValues, includes);
}

function asTargeting(value: unknown): ManagedAdTargeting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    include: record.include && typeof record.include === 'object' && !Array.isArray(record.include)
      ? record.include as TargetingBlock
      : undefined,
    exclude: record.exclude && typeof record.exclude === 'object' && !Array.isArray(record.exclude)
      ? record.exclude as TargetingBlock
      : undefined,
  };
}

export function managedAdSlotsForItemCount(
  placement: ManagedAdPlacementName,
  itemCount: number,
  itemOffset: number = 0
): ManagedAdSlot[] {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const offset = Math.max(0, Math.floor(Number(itemOffset) || 0));
  const firstAfter = placement === 'feed'
    ? MANAGED_AD_FEED_FIRST_AFTER_ITEMS
    : MANAGED_AD_REELS_FIRST_AFTER_ITEMS;
  const interval = placement === 'feed'
    ? MANAGED_AD_FEED_INTERVAL_ITEMS
    : MANAGED_AD_REELS_INTERVAL_ITEMS;

  const slots: ManagedAdSlot[] = [];
  const upperBound = offset + count;
  for (let afterItemCount = firstAfter; afterItemCount <= upperBound; afterItemCount += interval) {
    if (afterItemCount <= offset) continue;
    const sequence = Math.floor((afterItemCount - firstAfter) / interval);
    slots.push({
      placement,
      sequence,
      afterItemCount,
      slotKey: `${placement}_${sequence}`,
    });
  }
  return slots;
}

export function matchesManagedAdTargeting(
  targetingValue: unknown,
  profile: TargetProfile
): boolean {
  const targeting = asTargeting(targetingValue);
  const include = targeting.include;
  const exclude = targeting.exclude;

  return (
    matchesTextDimension(profile.colleges, include, exclude, 'colleges') &&
    matchesTextDimension(profile.branches, include, exclude, 'branches') &&
    matchesNumberDimension(profile.years, include, exclude, 'years') &&
    matchesNumberDimension(profile.currentYears, include, exclude, 'currentYears') &&
    matchesNumberDimension(profile.graduationYears, include, exclude, 'graduationYears') &&
    matchesTextDimension(profile.interests, include, exclude, 'interests') &&
    matchesTextDimension(profile.skills, include, exclude, 'skills') &&
    matchesTextDimension(profile.primaryGoals, include, exclude, 'primaryGoals') &&
    matchesTextDimension(profile.cities, include, exclude, 'cities') &&
    matchesTextDimension(profile.states, include, exclude, 'states') &&
    matchesTextDimension(profile.countries, include, exclude, 'countries') &&
    matchesTextDimension(profile.countryCodes, include, exclude, 'countryCodes') &&
    matchesTextDimension(profile.premiumStates, include, exclude, 'premiumStates') &&
    matchesTextDimension(profile.verification, include, exclude, 'verification') &&
    matchesBooleanDimension(profile.openToOpportunities, include, exclude, 'openToOpportunities')
  );
}

export function isManagedAdCtaAllowed(ctaKind: string | null | undefined, ctaUrl: string | null | undefined): boolean {
  if (!ctaUrl) return true;
  if (!ctaKind) return false;

  let parsed: URL;
  try {
    parsed = new URL(ctaUrl);
  } catch {
    return false;
  }

  if (ctaKind === 'external_url') {
    return parsed.protocol === 'https:';
  }

  if (ctaKind === 'vormex_deeplink') {
    return parsed.protocol === 'vormex:' || (parsed.protocol === 'https:' && WEB_HOSTS.has(parsed.hostname.toLowerCase()));
  }

  return false;
}

function campaignHasCreativeForPlacement(campaign: ManagedAdCampaignRecord, placement: ManagedAdPlacementName): boolean {
  if (!campaign.placements?.includes(placement)) return false;
  if (placement === 'feed') {
    return Boolean(campaign.feedTitle || campaign.feedBody || campaign.feedImageUrl);
  }
  return Boolean(campaign.reelsVideoUrl);
}

function campaignToPlacement(campaign: ManagedAdCampaignRecord, slot: ManagedAdSlot): ManagedAdPlacement {
  return {
    placement: slot.placement,
    sequence: slot.sequence,
    afterItemCount: slot.afterItemCount,
    slotKey: slot.slotKey,
    campaignId: campaign.id,
    sponsorName: campaign.sponsorName,
    ctaText: campaign.ctaText,
    ctaKind: campaign.ctaKind,
    ctaUrl: campaign.ctaUrl,
    feedTitle: campaign.feedTitle,
    feedBody: campaign.feedBody,
    feedImageUrl: campaign.feedImageUrl,
    reelCaption: campaign.reelCaption,
    reelsVideoUrl: campaign.reelsVideoUrl,
    reelsHlsUrl: campaign.reelsHlsUrl,
    reelsThumbnailUrl: campaign.reelsThumbnailUrl,
  };
}

function hashScore(value: string): number {
  return parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

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
    sessionImpressionCampaignIds(campaignIds, input.placement, input.sessionId),
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
