import type { UserResponse } from '../types/auth.types';
import { serializeProfileTheme } from '../constants/profile-themes';
import { getPremiumAccessSnapshot } from './premium-access.service';
import { publicTrustFields, trustLevelRank } from './trust-safety.service';
import { serializeCoarseLocation } from '../utils/location-dto.util';

export const safeUserResponseSelect = {
  id: true,
  email: true,
  username: true,
  name: true,
  profileImage: true,
  bio: true,
  college: true,
  branch: true,
  graduationYear: true,
  isVerified: true,
  authProvider: true,
  googleId: true,
  appleId: true,
  githubUsername: true,
  githubId: true,
  githubConnected: true,
  githubAvatarUrl: true,
  githubProfileUrl: true,
  githubLastSyncedAt: true,
  headline: true,
  bannerImageUrl: true,
  location: true,
  currentCity: true,
  currentState: true,
  currentCountry: true,
  currentYear: true,
  degree: true,
  portfolioUrl: true,
  linkedinUrl: true,
  otherSocialUrls: true,
  isOpenToOpportunities: true,
  interests: true,
  onboardingCompleted: true,
  identityTrustLevel: true,
  profileBadgeStyle: true,
  profileTheme: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ProfileCustomizationSource = {
  profileBadgeStyle?: string | null;
  profileTheme?: string | null;
  profileRing?: string | null;
  visitLoaderGiftId?: string | null;
  identityTrustLevel?: string | null;
};

export function buildProfileCustomizationResponseFields(
  user: ProfileCustomizationSource,
  canAccessProfileCustomization: boolean
) {
  const earnedStudentBadge =
    user.profileBadgeStyle?.toLowerCase() === 'student' &&
    trustLevelRank(user.identityTrustLevel) >= trustLevelRank('STUDENT_VERIFIED');

  return {
    profileBadgeStyle: canAccessProfileCustomization || earnedStudentBadge
      ? user.profileBadgeStyle ?? null
      : null,
    profileTheme: serializeProfileTheme(
      canAccessProfileCustomization ? user.profileTheme : null
    ),
    profileRing: canAccessProfileCustomization ? user.profileRing ?? null : null,
    visitLoaderGiftId: canAccessProfileCustomization ? user.visitLoaderGiftId ?? null : null,
  };
}

export async function buildUserResponse(user: any): Promise<UserResponse> {
  const snapshot = await getPremiumAccessSnapshot(String(user.id));
  const customizationFields = buildProfileCustomizationResponseFields(
    user,
    snapshot.canAccessProfileCustomization
  );

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    profileImage: user.profileImage,
    bio: user.bio,
    college: user.college,
    branch: user.branch,
    graduationYear: user.graduationYear,
    isVerified: user.isVerified,
    authProvider: user.authProvider,
    googleId: user.googleId,
    appleId: user.appleId,
    githubUsername: user.githubUsername,
    githubId: user.githubId,
    githubConnected: user.githubConnected,
    githubAvatarUrl: user.githubAvatarUrl,
    githubProfileUrl: user.githubProfileUrl,
    githubLastSyncedAt: user.githubLastSyncedAt,
    headline: user.headline,
    bannerImageUrl: user.bannerImageUrl,
    location: serializeCoarseLocation(user),
    currentYear: user.currentYear,
    degree: user.degree,
    portfolioUrl: user.portfolioUrl,
    linkedinUrl: user.linkedinUrl,
    otherSocialUrls: user.otherSocialUrls,
    isOpenToOpportunities: user.isOpenToOpportunities,
    interests: user.interests || [],
    onboardingCompleted: user.onboardingCompleted ?? false,
    ...publicTrustFields(user.identityTrustLevel),
    isPremium: snapshot.isPremium,
    canUseAgent: snapshot.canUseAgent,
    canAccessProfileCustomization: snapshot.canAccessProfileCustomization,
    profileBadgeStyle: customizationFields.profileBadgeStyle,
    profileTheme: customizationFields.profileTheme,
    premiumDisplayAmount: snapshot.premiumDisplayAmount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
