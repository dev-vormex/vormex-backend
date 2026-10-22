import { createHash } from "crypto";

export type ManagedAdPlacementName = 'feed' | 'reels' | 'sidebar';

export type ManagedAdEventType = 'impression' | 'click';

export const MANAGED_AD_FEED_FIRST_AFTER_ITEMS = 4;

export const MANAGED_AD_FEED_INTERVAL_ITEMS = 8;

export const MANAGED_AD_REELS_FIRST_AFTER_ITEMS = 5;

export const MANAGED_AD_REELS_INTERVAL_ITEMS = 8;

// The sidebar rail is a single persistent slot rather than an interleaved one,
// so it has no item cadence — one creative for the whole column.
export const MANAGED_AD_SIDEBAR_SLOT_KEY = 'sidebar_0';

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

export interface SelectManagedAdPlacementsInput {
  userId?: string | null;
  placement: ManagedAdPlacementName;
  itemCount: number;
  itemOffset?: number | null;
  sessionId?: string | null;
  now?: Date;
  // The sidebar rail refetches into the same single slot, so excluding
  // campaigns already seen this session would empty the column whenever an
  // advertiser is running alone. Interleaved placements keep the exclusion.
  ignoreSessionHistory?: boolean;
}

export interface TrackManagedAdEventInput {
  campaignId: string;
  userId?: string | null;
  eventType: ManagedAdEventType;
  placement: ManagedAdPlacementName;
  slotKey?: string | null;
  sessionId?: string | null;
}

export type ManagedAdCampaignRecord = {
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

export type TargetProfile = {
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

export function compactStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map(normalizeString)
        .filter((value): value is string => Boolean(value))
    )
  );
}

export function compactNumbers(values: unknown[]): number[] {
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
  if (placement === 'sidebar') {
    return [{
      placement,
      sequence: 0,
      afterItemCount: 0,
      slotKey: MANAGED_AD_SIDEBAR_SLOT_KEY,
    }];
  }

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

export function campaignHasCreativeForPlacement(campaign: ManagedAdCampaignRecord, placement: ManagedAdPlacementName): boolean {
  if (!campaign.placements?.includes(placement)) return false;
  // The sidebar rail renders the same copy/image as the in-feed card at a
  // narrower size, so it shares the feed creative rather than adding fields.
  if (placement === 'feed' || placement === 'sidebar') {
    return Boolean(campaign.feedTitle || campaign.feedBody || campaign.feedImageUrl);
  }
  return Boolean(campaign.reelsVideoUrl);
}

export function campaignToPlacement(campaign: ManagedAdCampaignRecord, slot: ManagedAdSlot): ManagedAdPlacement {
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

export function hashScore(value: string): number {
  return parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
