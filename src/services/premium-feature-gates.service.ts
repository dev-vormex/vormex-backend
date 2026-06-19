import type { Response } from 'express';
import {
  getPremiumAccessSnapshot,
  type PremiumAccessSnapshot,
} from './premium-access.service';

export type PremiumFeatureKey =
  | 'profile_insights'
  | 'profile_viewers'
  | 'profile_savers'
  | 'profile_customization'
  | 'discovery_rewind'
  | 'read_receipts';

type PremiumFeatureCopy = {
  title: string;
  error: string;
};

const PREMIUM_FEATURE_COPY: Record<PremiumFeatureKey, PremiumFeatureCopy> = {
  profile_insights: {
    title: 'Profile insights',
    error: 'Premium is required to view profile analytics and match insights.',
  },
  profile_viewers: {
    title: 'Profile viewers',
    error: 'Premium is required to see who viewed your profile.',
  },
  profile_savers: {
    title: 'Profile saves',
    error: 'Premium is required to see who saved or bookmarked your profile.',
  },
  profile_customization: {
    title: 'Profile customization',
    error: 'Premium is required to use profile themes, badges, frames, and visitor animations.',
  },
  discovery_rewind: {
    title: 'Discovery rewind',
    error: 'Premium is required to rewind skipped discovery suggestions.',
  },
  read_receipts: {
    title: 'Read receipts',
    error: 'Premium is required to see when your chat messages are read.',
  },
};

const PREMIUM_PROFILE_CUSTOMIZATION_FIELDS = [
  'profileRing',
  'visitLoaderGiftId',
  'profileTheme',
  'profileBadgeStyle',
] as const;

export function hasPremiumEntitlement(
  snapshot: Pick<PremiumAccessSnapshot, 'isPremium' | 'isCreatorPro' | 'user'> | null | undefined
): boolean {
  return Boolean(snapshot?.user?.isAdmin || snapshot?.isPremium || snapshot?.isCreatorPro);
}

export function getPremiumFeatureCopy(feature: PremiumFeatureKey): PremiumFeatureCopy {
  return PREMIUM_FEATURE_COPY[feature];
}

export function buildPremiumRequiredPayload(feature: PremiumFeatureKey) {
  const copy = getPremiumFeatureCopy(feature);
  return {
    success: false,
    error: copy.error,
    code: 'premium_required',
    feature,
    title: copy.title,
  };
}

export function sendPremiumRequiredResponse(
  res: Response,
  feature: PremiumFeatureKey,
  statusCode = 402
): void {
  res.status(statusCode).json(buildPremiumRequiredPayload(feature));
}

export async function canUserUsePremiumFeature(
  userId: string,
  _feature: PremiumFeatureKey
): Promise<boolean> {
  const snapshot = await getPremiumAccessSnapshot(userId);
  return hasPremiumEntitlement(snapshot);
}

export async function ensurePremiumFeatureAccess(
  userId: string,
  feature: PremiumFeatureKey
): Promise<{ ok: true } | { ok: false; statusCode: number; payload: ReturnType<typeof buildPremiumRequiredPayload> }> {
  const canUseFeature = await canUserUsePremiumFeature(userId, feature);
  if (canUseFeature) {
    return { ok: true };
  }

  return {
    ok: false,
    statusCode: 402,
    payload: buildPremiumRequiredPayload(feature),
  };
}

export function getPremiumProfileCustomizationFields(
  body: Record<string, unknown> | null | undefined
): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }

  return PREMIUM_PROFILE_CUSTOMIZATION_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field)
  );
}

export function hasPremiumProfileCustomizationUpdate(
  body: Record<string, unknown> | null | undefined
): boolean {
  return getPremiumProfileCustomizationFields(body).length > 0;
}
