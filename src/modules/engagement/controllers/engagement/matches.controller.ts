import { Response } from "express";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { prisma } from "../../../../config/prisma";
import { getPremiumVisibilityByUserIds } from "../../../premium/services/premium-visibility.service";
import { AuthRequest } from "./support.controller";
import { dailyMatchSnapshotWindow, DAILY_MATCH_CACHE_VERSION, DAILY_MATCH_WINDOW_MS, DAILY_MATCH_CACHE_TTL_SECONDS } from "./snapshot-support.controller";

// ======================
// DAILY MATCHES (Variable Rewards)
// ======================
export const getDailyMatches = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const snapshotWindow = dailyMatchSnapshotWindow();
    const cacheKey = [
      'matching:daily',
      DAILY_MATCH_CACHE_VERSION,
      `user:${userId}`,
      `window:${snapshotWindow}`,
    ].join(':');
    const payload = await cacheService.getOrSet(cacheKey, async () => {
      const [currentUser, existingConnections] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { college: true, interests: true },
        }),
        prisma.connections.findMany({
          where: {
            OR: [
              { requesterId: userId },
              { addresseeId: userId },
            ],
          },
          select: { requesterId: true, addresseeId: true },
        }),
      ]);

      const connectedUserIds = new Set<string>();
      existingConnections.forEach((connection) => {
        connectedUserIds.add(connection.requesterId);
        connectedUserIds.add(connection.addresseeId);
      });
      connectedUserIds.add(userId);

      // Variable rewards should vary between days, not between page reloads.
      const matchCount = Math.floor(Math.random() * 5) + 1;
      const potentialMatches = await prisma.user.findMany({
        where: {
          id: { notIn: Array.from(connectedUserIds) },
          isBanned: false,
        },
        select: {
          id: true,
          username: true,
          name: true,
          profileImage: true,
          headline: true,
          college: true,
          lastActiveAt: true,
          interests: true,
          isVerified: true,
          profileBadgeStyle: true,
        },
        take: matchCount * 3,
      });

      const scoredMatches = potentialMatches.map((user) => {
        let score = 0;
        if (currentUser?.college && user.college === currentUser.college) score += 20;
        if (currentUser?.interests && user.interests) {
          const userInterests = Array.isArray(user.interests) ? user.interests : [];
          const myInterests = Array.isArray(currentUser.interests) ? currentUser.interests : [];
          score += userInterests.filter((interest: string) => myInterests.includes(interest)).length * 10;
        }
        if (user.lastActiveAt && new Date(user.lastActiveAt) > new Date(Date.now() - DAILY_MATCH_WINDOW_MS)) {
          score += 10;
        }
        return { ...user, score };
      });

      const topMatches = scoredMatches
        .sort((a, b) => b.score - a.score)
        .slice(0, matchCount);
      const premiumVisibilityByUser = await getPremiumVisibilityByUserIds(
        topMatches.map((user) => user.id)
      );
      const matches = topMatches.map((user) => ({
        id: user.id,
        username: user.username,
        name: user.name,
        profileImage: user.profileImage,
        headline: user.headline,
        college: user.college,
        verified: Boolean(user.isVerified),
        isVerified: Boolean(user.isVerified),
        profileBadgeStyle: user.profileBadgeStyle ?? null,
        isPremium: Boolean(premiumVisibilityByUser.get(user.id)?.isPremium),
        isOnline: user.lastActiveAt
          ? new Date(user.lastActiveAt) > new Date(Date.now() - 5 * 60 * 1000)
          : false,
        // Selected above but previously dropped here, so every client that read
        // `match.interests` got undefined — shared-interest chips could never render.
        interests: Array.isArray(user.interests) ? user.interests : [],
        // FIXME: not a measured value. Clients display this as "N% reply rate"
        // and push notifications repeat it verbatim. Needs a real metric or removal.
        replyRate: Math.floor(Math.random() * 40) + 60,
      }));
      const surpriseMessages = [
        'You have new matches waiting!',
        'Someone from your college is here!',
        'A perfect match just joined!',
        'Great networking opportunities today!',
        'Check back tomorrow for more matches!',
      ];

      return {
        matches,
        matchCount: matches.length,
        surpriseMessage: matches.length > 0
          ? surpriseMessages[Math.floor(Math.random() * (surpriseMessages.length - 1))]
          : surpriseMessages[surpriseMessages.length - 1],
        snapshotWindow,
      };
    }, {
      ttlSeconds: DAILY_MATCH_CACHE_TTL_SECONDS,
      lockTtlMs: 30_000,
      tags: [
        `matching:user:${userId}`,
        `people:user:${userId}`,
        `people:connections:${userId}`,
      ],
    });

    res.setHeader('X-Vormex-Cache', 'SNAPSHOT');
    res.setHeader('X-Vormex-Match-Window', String(snapshotWindow));
    res.json({ data: payload });
  } catch (error) {
    console.error('getDailyMatches error:', error);
    res.status(500).json({ error: 'Failed to fetch daily matches' });
  }
};

// ======================
// PEOPLE LIKE YOU (Social Proof - Similar Users)
// ======================
export const getPeopleLikeYou = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Get current user for matching
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { college: true, interests: true, user_onboarding: { select: { primaryGoal: true } } },
    });

    // Get existing connections to exclude
    const existingConnections = await prisma.connections.findMany({
      where: {
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const connectedUserIds = new Set<string>();
    existingConnections.forEach((conn) => {
      connectedUserIds.add(conn.requesterId);
      connectedUserIds.add(conn.addresseeId);
    });
    connectedUserIds.add(userId);

    // Find users with similar interests, goals, or same college
    const potentialMatches = await prisma.user.findMany({
      where: {
        id: { notIn: Array.from(connectedUserIds) },
        isBanned: false,
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
        college: true,
        lastActiveAt: true,
        interests: true,
        user_onboarding: { select: { primaryGoal: true } },
      },
      take: 30, // Get enough users to filter
    });

    const currentUserGoal = currentUser?.user_onboarding?.primaryGoal;

    // Score users by similarity
    const scoredMatches = potentialMatches.map((user) => {
      let score = 0;
      let matchReason = '';
      const userGoal = user.user_onboarding?.primaryGoal;

      // Check goal match (highest priority)
      if (currentUserGoal && userGoal === currentUserGoal) {
        score += 30;
        matchReason = 'Same goal';
      }

      // Check college match
      if (currentUser?.college && user.college === currentUser.college) {
        score += 25;
        if (!matchReason) matchReason = 'Same college';
      }

      // Check interest overlap
      if (currentUser?.interests && user.interests) {
        const userInterests = Array.isArray(user.interests) ? user.interests : [];
        const myInterests = Array.isArray(currentUser.interests) ? currentUser.interests : [];
        const overlap = userInterests.filter((i: string) => myInterests.includes(i)).length;
        if (overlap > 0) {
          score += overlap * 10;
          if (!matchReason) matchReason = `${overlap} shared interest${overlap > 1 ? 's' : ''}`;
        }
      }

      // Boost recently active users
      if (user.lastActiveAt && new Date(user.lastActiveAt) > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
        score += 5;
      }

      return { ...user, score, matchReason: matchReason || 'Recommended' };
    });

    // Sort by score and take top 8 users
    const people = scoredMatches
      .filter((u) => u.score > 0) // Only show users with some similarity
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((user) => ({
        id: user.id,
        username: user.username,
        name: user.name,
        profileImage: user.profileImage,
        headline: user.headline,
        college: user.college,
        isOnline: user.lastActiveAt ? new Date(user.lastActiveAt) > new Date(Date.now() - 5 * 60 * 1000) : false,
        // Selected above but previously dropped here — see the daily-matches mapping.
        interests: Array.isArray(user.interests) ? user.interests : [],
        // FIXME: not a measured value — same fabricated metric as daily matches.
        replyRate: Math.floor(Math.random() * 30) + 70, // 70-100%
        matchReason: user.matchReason,
      }));

    res.json({
      data: {
        people,
        count: people.length,
      },
    });
  } catch (error) {
    console.error('getPeopleLikeYou error:', error);
    res.status(500).json({ error: 'Failed to fetch similar users' });
  }
};

// ======================
// HIDDEN GEM (Variable Reward)
// ======================
export const getHiddenGem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Get existing connections to exclude
    const existingConnections = await prisma.connections.findMany({
      where: {
        OR: [
          { requesterId: userId },
          { addresseeId: userId },
        ],
      },
      select: { requesterId: true, addresseeId: true },
    });

    const connectedUserIds = new Set<string>();
    existingConnections.forEach((conn) => {
      connectedUserIds.add(conn.requesterId);
      connectedUserIds.add(conn.addresseeId);
    });
    connectedUserIds.add(userId);

    // Find a "hidden gem" - high-quality user with good stats
    const hiddenGem = await prisma.user.findFirst({
      where: {
        id: { notIn: Array.from(connectedUserIds) },
        isBanned: false,
        userStats: {
          connectionsCount: { gte: 10 },
        },
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        headline: true,
        college: true,
        lastActiveAt: true,
        isVerified: true,
        profileBadgeStyle: true,
      },
      orderBy: {
        userStats: { connectionsCount: 'desc' },
      },
    });

    if (!hiddenGem) {
      res.json({ data: null });
      return;
    }

    const hiddenGemPremiumVisibility = await getPremiumVisibilityByUserIds([hiddenGem.id]);

    res.json({
      data: {
        match: {
          id: hiddenGem.id,
          username: hiddenGem.username,
          name: hiddenGem.name,
          profileImage: hiddenGem.profileImage,
          headline: hiddenGem.headline,
          college: hiddenGem.college,
          verified: Boolean(hiddenGem.isVerified),
          isVerified: Boolean(hiddenGem.isVerified),
          profileBadgeStyle: hiddenGem.profileBadgeStyle ?? null,
          isPremium: Boolean(hiddenGemPremiumVisibility.get(hiddenGem.id)?.isPremium),
          isOnline: hiddenGem.lastActiveAt ? new Date(hiddenGem.lastActiveAt) > new Date(Date.now() - 5 * 60 * 1000) : false,
          replyRate: 85,
        },
        message: "This week's hidden gem - a highly connected professional!",
      },
    });
  } catch (error) {
    console.error('getHiddenGem error:', error);
    res.status(500).json({ error: 'Failed to fetch hidden gem' });
  }
};
