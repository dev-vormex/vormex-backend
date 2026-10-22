import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getSuggestionQuotaState, hasActiveDiscoveryPasses, getActiveDiscoveryPassTargetIds, recordSuggestionImpressions, passDiscoveryUser, rewindLastDiscoveryPass } from "../../services/discovery-power.service";
import { prismaRead } from "../../../../config/prisma";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { getPremiumVisibilityByUserIds, sortByPremiumVisibility } from "../../../premium/services/premium-visibility.service";
import { decorateSurfaceRecommendations } from "../../services/surface-recommendation.service";
import { ensurePremiumFeatureAccess } from "../../../premium/services/premium-feature-gates.service";
import { PersonCard, SuggestionQuota, parseBoundedInt, PEOPLE_PERSONALIZED_MAX_LIMIT, peopleOrderBy, personCardUserSelect, getRelationshipSummary, mapUserToPersonCard, normalizeSearchText } from "./support.controller";

/**
 * Get personalized suggestions
 * GET /api/people/suggestions
 */
export const getSuggestions = async (
  req: AuthenticatedRequest,
  res: Response<{
    suggestions: PersonCard[];
    total?: number;
    hasMore?: boolean;
    quota?: SuggestionQuota;
    canRewind?: boolean;
  } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const page = parseBoundedInt(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = parseBoundedInt(req.query.limit, 10, 1, PEOPLE_PERSONALIZED_MAX_LIMIT);
    const skip = (page - 1) * limit;
    const quota = await getSuggestionQuotaState(userId);
    const effectiveLimit = quota.isPremium
      ? limit
      : Math.min(limit, quota.remaining ?? 0);
    const canRewind = await hasActiveDiscoveryPasses(userId);

    if (effectiveLimit <= 0) {
      res.setHeader('X-Vormex-Cache', 'BYPASS');
      res.status(200).json({
        suggestions: [],
        total: 0,
        hasMore: false,
        quota,
        canRewind,
      });
      return;
    }

    const currentUser = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { college: true, branch: true, interests: true, graduationYear: true },
    });

    if (!currentUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [passedTargetIds, blockedUserIds] = await Promise.all([
      getActiveDiscoveryPassTargetIds(userId),
      getBlockedUserIds(userId),
    ]);

    const suggestionSignals: any[] = [];
    if (currentUser.college) suggestionSignals.push({ college: currentUser.college });
    if (currentUser.branch) suggestionSignals.push({ branch: currentUser.branch });
    if (currentUser.interests.length > 0) {
      suggestionSignals.push({ interests: { hasSome: currentUser.interests } });
    }
    if (currentUser.graduationYear) suggestionSignals.push({ graduationYear: currentUser.graduationYear });

    const users = await prismaRead.user.findMany({
      where: {
        id: { notIn: [userId, ...passedTargetIds, ...blockedUserIds] },
        isBanned: false,
        ...(suggestionSignals.length > 0 ? { OR: suggestionSignals } : {}),
      },
      skip,
      take: effectiveLimit,
      orderBy: peopleOrderBy,
      select: personCardUserSelect,
    });

    const visibilityByUser = await getPremiumVisibilityByUserIds(users.map((user) => user.id));
    const relationship = await getRelationshipSummary(userId, users.map((user) => user.id));
    const suggestions: PersonCard[] = sortByPremiumVisibility(
      users.filter((user) => !relationship.connectionStatusByUser.has(user.id)),
      visibilityByUser
    ).map((user) => mapUserToPersonCard(user, relationship, visibilityByUser));
    const updatedQuota = await recordSuggestionImpressions(
      userId,
      suggestions.map((suggestion) => suggestion.id),
      quota
    );
    const decorated = await decorateSurfaceRecommendations({
      userId,
      surface: 'PEOPLE',
      entityType: 'PERSON',
      items: suggestions,
      authorIdOf: (person) => person.id,
      pageSize: suggestions.length || 1,
    });
    const response = {
      suggestions: decorated.items,
      total: skip + suggestions.length + (users.length === effectiveLimit ? 1 : 0),
      page,
      hasMore:
        users.length === effectiveLimit &&
        (updatedQuota.isPremium || (updatedQuota.remaining ?? 0) > 0),
      quota: updatedQuota,
      canRewind,
      recommendationSessionId: decorated.recommendationSessionId,
      requestId: decorated.requestId,
      rankerVersion: decorated.rankerVersion,
      experimentVariant: decorated.experimentVariant,
    };

    res.setHeader('X-Vormex-Cache', 'BYPASS');
    res.status(200).json(response as any);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
};

export const passDiscoverySuggestion = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string; targetUserId: string; canRewind: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const targetUserId = normalizeSearchText(req.body?.targetUserId || req.body?.userId, 80);
    if (!targetUserId) {
      res.status(400).json({ error: 'targetUserId is required' });
      return;
    }

    await passDiscoveryUser(userId, targetUserId);
    res.status(200).json({
      message: 'Suggestion passed',
      targetUserId,
      canRewind: true,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to pass suggestion';
    res.status(message === 'User not found' ? 404 : 400).json({ error: message });
  }
};

export const rewindDiscoveryPass = async (
  req: AuthenticatedRequest,
  res: Response<{ rewound: boolean; targetUserId?: string | null; canRewind: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const premiumAccess = await ensurePremiumFeatureAccess(userId, 'discovery_rewind');
    if (premiumAccess.ok === false) {
      res.status(premiumAccess.statusCode).json(premiumAccess.payload);
      return;
    }

    const rewound = await rewindLastDiscoveryPass(userId);
    res.status(200).json({
      rewound: Boolean(rewound),
      targetUserId: rewound?.targetUserId || null,
      canRewind: await hasActiveDiscoveryPasses(userId),
    });
  } catch (error) {
    console.error('Error rewinding discovery pass:', error);
    res.status(500).json({ error: 'Failed to rewind suggestion' });
  }
};
