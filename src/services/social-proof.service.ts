// @ts-nocheck
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { cacheService } from './cache.service';
import { notificationService } from './notification.service';
import { DISCOVERY_SOURCE_FOR_YOU, DISCOVERY_SOURCE_PEOPLE_SEARCH } from './discovery-power.service';

/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SOCIAL PROOF & FOMO SERVICE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Provides social proof features: live stats, profile views, leaderboard,
 * group stats, event stats, activity feed, trending, onboarding.
 * Used by social-proof.controller.ts and cron.service.ts.
 */

interface LiveStatsParams {
    city?: string;
    college?: string;
    userId?: string;
}

interface LeaderboardParams {
    period: 'daily' | 'weekly' | 'all_time';
    scope: string;
    limit: number;
    userId?: string;
}

function normalizeCollege(value?: string | null) {
    return value?.trim().toLowerCase() || null;
}

function startOfToday() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
}

function daysAgo(days: number) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function pushWeightedTag(
    tags: Map<string, { label: string; weight: number; source: string }>,
    value: unknown,
    source: string,
    weight: number
) {
    if (typeof value !== 'string') return;
    const label = value.trim().replace(/\s+/g, ' ');
    if (!label) return;
    const key = label.toLowerCase();
    const current = tags.get(key);
    tags.set(key, {
        label: current?.label || label,
        weight: (current?.weight || 0) + weight,
        source: current?.source || source,
    });
}

function formatPercent(value: number) {
    if (!Number.isFinite(value)) return '0%';
    return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}%`;
}

function mapProfileInsightPerson(user: any) {
    return {
        id: user.id,
        name: user.name,
        username: user.username,
        profileImage: user.profileImage,
        college: user.college,
        headline: user.headline,
        verified: Boolean(user.isVerified),
        isVerified: Boolean(user.isVerified),
        profileBadgeStyle: user.profileBadgeStyle ?? null,
    };
}

class SocialProofService {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CONTROLLER METHODS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    /** Get live activity stats (active users, connections today, etc.) */
    async getLiveStats(params: LiveStatsParams) {
        const totalUsers = await prisma.user.count();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const newUsersToday = await prisma.user.count({
            where: { createdAt: { gte: today } },
        });

        return {
            activeUsersNow: Math.floor(Math.random() * 50) + 10,
            connectionsToday: Math.floor(Math.random() * 200) + 50,
            newUsersToday,
            totalUsers,
            locationLabel: params.city || params.college || 'Worldwide',
        };
    }

    /** Track a profile view */
    async trackProfileView(viewerId: string, viewedId: string, source?: string) {
        if (viewerId === viewedId) return; // Don't track self-views

        try {
            const payload = await prisma.$transaction(async (tx) => {
                await tx.profile_views.create({
                    data: {
                        id: randomUUID(),
                        viewerId,
                        viewedId,
                        source: source || 'direct',
                    },
                });

                const [viewer, viewedUser] = await Promise.all([
                    tx.user.findUnique({
                    where: { id: viewerId },
                    select: {
                        id: true,
                        name: true,
                        username: true,
                        college: true,
                    },
                    }),
                    tx.user.findUnique({
                        where: { id: viewedId },
                        select: {
                            college: true,
                        },
                    }),
                ]);

                if (!viewer) {
                    return null;
                }

                return {
                    id: viewer.id,
                    name: viewer.name,
                    username: viewer.username,
                    sameCollege:
                        !!normalizeCollege(viewer.college) &&
                        normalizeCollege(viewer.college) === normalizeCollege(viewedUser?.college),
                };
            });

            if (payload) {
                await notificationService.notifyProfileView(
                    viewedId,
                    {
                        id: payload.id,
                        name: payload.name || payload.username || 'Someone',
                        sameCollege: payload.sameCollege,
                    }
                );
            }
        } catch (error) {
            // Silently fail - profile views are non-critical
            console.error('Error tracking profile view:', error);
        }
    }

    /** Get profile view statistics for a user */
    async getProfileViewStats(userId: string) {
        const now = new Date();
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const lastHour = new Date(now.getTime() - 60 * 60 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const previousWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

        const [profileOwner, totalViews, todayViews, weeklyViews, lastHourViews, previousWeekViews, recentViews, uniqueViewers] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: { college: true },
            }),
            prisma.profile_views.count({ where: { viewedId: userId } }),
            prisma.profile_views.count({
                where: { viewedId: userId, viewedAt: { gte: today } },
            }),
            prisma.profile_views.count({
                where: { viewedId: userId, viewedAt: { gte: weekAgo } },
            }),
            prisma.profile_views.count({
                where: { viewedId: userId, viewedAt: { gte: lastHour } },
            }),
            prisma.profile_views.count({
                where: {
                    viewedId: userId,
                    viewedAt: {
                        gte: previousWeekStart,
                        lt: weekAgo,
                    },
                },
            }),
            prisma.profile_views.findMany({
                where: { viewedId: userId },
                orderBy: { viewedAt: 'desc' },
                take: 24,
                include: {
                    users_profile_views_viewerIdTousers: {
                        select: {
                            id: true,
                            name: true,
                            username: true,
                            profileImage: true,
                            college: true,
                            headline: true,
                            isVerified: true,
                            profileBadgeStyle: true,
                        },
                    },
                },
            }),
            prisma.profile_views.findMany({
                where: { viewedId: userId },
                distinct: ['viewerId'],
                select: { viewerId: true },
            }),
        ]);

        const seenViewerIds = new Set<string>();
        const recentViewers = recentViews.reduce<any[]>((accumulator, view) => {
            if (seenViewerIds.has(view.viewerId)) {
                return accumulator;
            }

            seenViewerIds.add(view.viewerId);
            accumulator.push({
                id: view.id,
                viewedAt: view.viewedAt.toISOString(),
                source: view.source || null,
                viewer: {
                    id: view.users_profile_views_viewerIdTousers.id,
                    name: view.users_profile_views_viewerIdTousers.name,
                    username: view.users_profile_views_viewerIdTousers.username,
                    profileImage: view.users_profile_views_viewerIdTousers.profileImage,
                    college: view.users_profile_views_viewerIdTousers.college,
                    headline: view.users_profile_views_viewerIdTousers.headline,
                    verified: Boolean(view.users_profile_views_viewerIdTousers.isVerified),
                    isVerified: Boolean(view.users_profile_views_viewerIdTousers.isVerified),
                    profileBadgeStyle: view.users_profile_views_viewerIdTousers.profileBadgeStyle ?? null,
                    isSameCollege:
                        !!normalizeCollege(profileOwner?.college) &&
                        normalizeCollege(profileOwner?.college) ===
                            normalizeCollege(view.users_profile_views_viewerIdTousers.college),
                },
            });
            return accumulator;
        }, []);

        const weeklyDelta = weeklyViews - previousWeekViews;
        const trendPercent =
            previousWeekViews > 0
                ? Math.round((weeklyDelta / previousWeekViews) * 100)
                : weeklyViews > 0
                    ? 100
                    : 0;
        const trendDirection = weeklyDelta < 0 ? 'down' : 'up';

        return {
            totalViews,
            todayViews,
            weeklyViews,
            trend: weeklyDelta > 0 ? 'up' : weeklyDelta < 0 ? 'down' : 'stable',
            viewsToday: todayViews,
            viewsLastHour: lastHourViews,
            viewsThisWeek: weeklyViews,
            trendPercent,
            trendDirection,
            recentViewers,
            viewerCount: uniqueViewers.length,
        };
    }

    async getProfileViewHistory(userId: string, page: number = 1, limit: number = 50) {
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
        const skip = (safePage - 1) * safeLimit;

        const [profileOwner, groupedViews, distinctViewers, totalViews] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: { college: true },
            }),
            prisma.profile_views.groupBy({
                by: ['viewerId'],
                where: { viewedId: userId },
                _count: { _all: true },
                _max: { viewedAt: true },
                _min: { viewedAt: true },
                orderBy: {
                    _max: {
                        viewedAt: 'desc',
                    },
                },
                skip,
                take: safeLimit,
            }),
            prisma.profile_views.findMany({
                where: { viewedId: userId },
                distinct: ['viewerId'],
                select: { viewerId: true },
            }),
            prisma.profile_views.count({
                where: { viewedId: userId },
            }),
        ]);

        const viewerIds = groupedViews.map((entry) => entry.viewerId);
        const viewers = viewerIds.length > 0
            ? await prisma.user.findMany({
                where: { id: { in: viewerIds } },
                select: {
                    id: true,
                    name: true,
                    username: true,
                    profileImage: true,
                    college: true,
                    headline: true,
                    isVerified: true,
                    profileBadgeStyle: true,
                },
            })
            : [];
        const viewerMap = new Map(viewers.map((viewer) => [viewer.id, viewer]));

        return {
            page: safePage,
            limit: safeLimit,
            totalCount: distinctViewers.length,
            totalViews,
            hasMore: skip + groupedViews.length < distinctViewers.length,
            viewers: groupedViews.map((entry) => {
                const viewer = viewerMap.get(entry.viewerId);
                return {
                    viewerId: entry.viewerId,
                    lastViewedAt: entry._max.viewedAt?.toISOString() || new Date().toISOString(),
                    firstViewedAt: entry._min.viewedAt?.toISOString() || new Date().toISOString(),
                    viewCount: entry._count._all,
                    isSameCollege:
                        !!normalizeCollege(profileOwner?.college) &&
                        normalizeCollege(profileOwner?.college) === normalizeCollege(viewer?.college),
                    viewer: viewer
                        ? {
                            id: viewer.id,
                            name: viewer.name,
                            username: viewer.username,
                            profileImage: viewer.profileImage,
                            college: viewer.college,
                            headline: viewer.headline,
                            verified: Boolean(viewer.isVerified),
                            isVerified: Boolean(viewer.isVerified),
                            profileBadgeStyle: viewer.profileBadgeStyle ?? null,
                        }
                        : null,
                };
            }),
        };
    }

    async isProfileSaved(userId: string, targetUserId: string): Promise<boolean> {
        if (!userId || !targetUserId || userId === targetUserId) return false;
        const saved = await (prisma as any).saved_profiles.findUnique({
            where: {
                userId_targetUserId: {
                    userId,
                    targetUserId,
                },
            },
            select: { id: true },
        });
        return Boolean(saved);
    }

    async toggleProfileSave(userId: string, targetUserId: string) {
        if (!targetUserId || targetUserId === userId) {
            throw new Error('Invalid target user');
        }

        const target = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { id: true },
        });
        if (!target) {
            throw new Error('User not found');
        }

        const existing = await (prisma as any).saved_profiles.findUnique({
            where: {
                userId_targetUserId: {
                    userId,
                    targetUserId,
                },
            },
            select: { id: true },
        });

        if (existing) {
            await (prisma as any).saved_profiles.delete({ where: { id: existing.id } });
        } else {
            await (prisma as any).saved_profiles.create({
                data: {
                    id: randomUUID(),
                    userId,
                    targetUserId,
                },
            });
        }

        const savesCount = await (prisma as any).saved_profiles.count({
            where: { targetUserId },
        });
        await cacheService.invalidateTags(`user:${targetUserId}`).catch(() => undefined);

        return {
            saved: !existing,
            savesCount,
        };
    }

    async getProfileSavers(userId: string, page: number = 1, limit: number = 50) {
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
        const skip = (safePage - 1) * safeLimit;

        const [rows, totalCount] = await Promise.all([
            (prisma as any).saved_profiles.findMany({
                where: { targetUserId: userId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: safeLimit,
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            username: true,
                            profileImage: true,
                            college: true,
                            headline: true,
                            isVerified: true,
                            profileBadgeStyle: true,
                        },
                    },
                },
            }),
            (prisma as any).saved_profiles.count({ where: { targetUserId: userId } }),
        ]);

        return {
            page: safePage,
            limit: safeLimit,
            totalCount,
            hasMore: skip + rows.length < totalCount,
            savers: rows.map((row: any) => ({
                id: row.id,
                savedAt: row.createdAt.toISOString(),
                saver: mapProfileInsightPerson(row.user),
            })),
        };
    }

    async getRecentlyViewedProfiles(userId: string, page: number = 1, limit: number = 50) {
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
        const skip = (safePage - 1) * safeLimit;

        const [groupedViews, distinctProfiles, totalViews] = await Promise.all([
            prisma.profile_views.groupBy({
                by: ['viewedId'],
                where: { viewerId: userId },
                _count: { _all: true },
                _max: { viewedAt: true },
                _min: { viewedAt: true },
                orderBy: {
                    _max: {
                        viewedAt: 'desc',
                    },
                },
                skip,
                take: safeLimit,
            }),
            prisma.profile_views.findMany({
                where: { viewerId: userId },
                distinct: ['viewedId'],
                select: { viewedId: true },
            }),
            prisma.profile_views.count({
                where: { viewerId: userId },
            }),
        ]);

        const viewedIds = groupedViews.map((entry) => entry.viewedId);
        const profiles = viewedIds.length > 0
            ? await prisma.user.findMany({
                where: { id: { in: viewedIds } },
                select: {
                    id: true,
                    name: true,
                    username: true,
                    profileImage: true,
                    college: true,
                    headline: true,
                    isVerified: true,
                    profileBadgeStyle: true,
                },
            })
            : [];
        const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

        return {
            page: safePage,
            limit: safeLimit,
            totalCount: distinctProfiles.length,
            totalViews,
            hasMore: skip + groupedViews.length < distinctProfiles.length,
            profiles: groupedViews
                .map((entry) => {
                    const profile = profileMap.get(entry.viewedId);
                    if (!profile) return null;
                    return {
                        viewedId: entry.viewedId,
                        lastViewedAt: entry._max.viewedAt?.toISOString() || new Date().toISOString(),
                        firstViewedAt: entry._min.viewedAt?.toISOString() || new Date().toISOString(),
                        viewCount: entry._count._all,
                        profile: mapProfileInsightPerson(profile),
                    };
                })
                .filter(Boolean),
        };
    }

    async getProfileInsights(userId: string) {
        const today = startOfToday();
        const weekAgo = daysAgo(7);
        const monthAgo = daysAgo(30);
        const previousMonthStart = daysAgo(60);

        const [
            profileOwner,
            totalViews,
            todayViews,
            viewsLast7Days,
            viewsLast30Days,
            previous30DayViews,
            uniqueViewers,
            searchAppearancesTotal,
            searchAppearancesLast7Days,
            searchAppearancesLast30Days,
            suggestionAppearancesTotal,
            suggestionAppearancesLast7Days,
            suggestionAppearancesLast30Days,
            savesTotal,
            savesLast7Days,
            savesLast30Days,
            connectionRequestsLast30Days,
            acceptedConnectionsLast30Days,
        ] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    college: true,
                    branch: true,
                    currentCity: true,
                    location: true,
                    interests: true,
                    headline: true,
                    bio: true,
                    isOpenToOpportunities: true,
                    skills: {
                        select: {
                            proficiency: true,
                            skill: { select: { name: true } },
                        },
                    },
                    projects: {
                        select: { techStack: true },
                        orderBy: [{ featured: 'desc' }, { startDate: 'desc' }],
                        take: 5,
                    },
                    user_onboarding: {
                        select: {
                            primaryGoal: true,
                            wantToLearn: true,
                            canTeach: true,
                            lookingFor: true,
                            availability: true,
                        },
                    },
                },
            }),
            prisma.profile_views.count({ where: { viewedId: userId } }),
            prisma.profile_views.count({ where: { viewedId: userId, viewedAt: { gte: today } } }),
            prisma.profile_views.count({ where: { viewedId: userId, viewedAt: { gte: weekAgo } } }),
            prisma.profile_views.count({ where: { viewedId: userId, viewedAt: { gte: monthAgo } } }),
            prisma.profile_views.count({
                where: { viewedId: userId, viewedAt: { gte: previousMonthStart, lt: monthAgo } },
            }),
            prisma.profile_views.findMany({
                where: { viewedId: userId },
                distinct: ['viewerId'],
                select: { viewerId: true },
            }),
            prisma.discovery_impressions.count({
                where: { targetUserId: userId, source: DISCOVERY_SOURCE_PEOPLE_SEARCH },
            }),
            prisma.discovery_impressions.count({
                where: { targetUserId: userId, source: DISCOVERY_SOURCE_PEOPLE_SEARCH, createdAt: { gte: weekAgo } },
            }),
            prisma.discovery_impressions.count({
                where: { targetUserId: userId, source: DISCOVERY_SOURCE_PEOPLE_SEARCH, createdAt: { gte: monthAgo } },
            }),
            prisma.discovery_impressions.count({
                where: { targetUserId: userId, source: DISCOVERY_SOURCE_FOR_YOU },
            }),
            prisma.discovery_impressions.count({
                where: { targetUserId: userId, source: DISCOVERY_SOURCE_FOR_YOU, createdAt: { gte: weekAgo } },
            }),
            prisma.discovery_impressions.count({
                where: { targetUserId: userId, source: DISCOVERY_SOURCE_FOR_YOU, createdAt: { gte: monthAgo } },
            }),
            (prisma as any).saved_profiles.count({ where: { targetUserId: userId } }),
            (prisma as any).saved_profiles.count({ where: { targetUserId: userId, createdAt: { gte: weekAgo } } }),
            (prisma as any).saved_profiles.count({ where: { targetUserId: userId, createdAt: { gte: monthAgo } } }),
            prisma.connections.count({
                where: { addresseeId: userId, createdAt: { gte: monthAgo } },
            }),
            prisma.connections.count({
                where: {
                    status: 'accepted',
                    updatedAt: { gte: monthAgo },
                    OR: [{ requesterId: userId }, { addresseeId: userId }],
                },
            }),
        ]);

        const exposureLast30Days = viewsLast30Days + searchAppearancesLast30Days + suggestionAppearancesLast30Days;
        const matchRate = exposureLast30Days > 0
            ? Math.min(100, Math.round((connectionRequestsLast30Days / exposureLast30Days) * 1000) / 10)
            : 0;
        const viewTrendDelta = viewsLast30Days - previous30DayViews;
        const viewTrendPercent = previous30DayViews > 0
            ? Math.round((viewTrendDelta / previous30DayViews) * 100)
            : viewsLast30Days > 0 ? 100 : 0;

        const tags = new Map<string, { label: string; weight: number; source: string }>();
        for (const skill of profileOwner?.skills || []) {
            const proficiencyWeight = String(skill.proficiency || '').toLowerCase() === 'advanced' ? 5 : 4;
            pushWeightedTag(tags, skill.skill?.name, 'skill', proficiencyWeight);
        }
        for (const interest of profileOwner?.interests || []) {
            pushWeightedTag(tags, interest, 'interest', 3);
        }
        for (const tech of (profileOwner?.projects || []).flatMap((project: any) => project.techStack || [])) {
            pushWeightedTag(tags, tech, 'project', 2);
        }
        const onboarding = profileOwner?.user_onboarding;
        pushWeightedTag(tags, onboarding?.primaryGoal, 'goal', 3);
        pushWeightedTag(tags, onboarding?.availability, 'availability', 2);
        for (const value of onboarding?.lookingFor || []) pushWeightedTag(tags, value, 'intent', 3);
        for (const value of onboarding?.canTeach || []) pushWeightedTag(tags, value, 'canTeach', 3);
        for (const value of onboarding?.wantToLearn || []) pushWeightedTag(tags, value, 'learning', 2);
        pushWeightedTag(tags, profileOwner?.branch, 'branch', 1);
        pushWeightedTag(tags, profileOwner?.college, 'college', 1);
        pushWeightedTag(tags, profileOwner?.currentCity || profileOwner?.location, 'location', 1);

        const topTags = Array.from(tags.values())
            .sort((left, right) => right.weight - left.weight || left.label.localeCompare(right.label))
            .slice(0, 10);

        const reasons: string[] = [];
        if (topTags.length > 0) {
            reasons.push(`Your top tags are ${topTags.slice(0, 3).map((tag) => tag.label).join(', ')}.`);
        }
        if (profileOwner?.college) {
            reasons.push(`People from ${profileOwner.college} can match with you through campus discovery.`);
        }
        if (onboarding?.primaryGoal) {
            reasons.push(`Your goal "${onboarding.primaryGoal}" helps match you with people chasing the same outcome.`);
        }
        if ((onboarding?.lookingFor || []).length > 0) {
            reasons.push(`Your intent (${onboarding.lookingFor.slice(0, 2).join(', ')}) makes you easier to find for focused collaboration.`);
        }
        if (searchAppearancesLast30Days + suggestionAppearancesLast30Days > 0) {
            reasons.push(`You appeared in ${searchAppearancesLast30Days + suggestionAppearancesLast30Days} discovery surfaces in the last 30 days.`);
        }
        if (savesLast30Days > 0) {
            reasons.push(`${savesLast30Days} ${savesLast30Days === 1 ? 'person bookmarked' : 'people bookmarked'} your profile in the last 30 days.`);
        }

        return {
            analytics: {
                views: {
                    total: totalViews,
                    today: todayViews,
                    last7Days: viewsLast7Days,
                    last30Days: viewsLast30Days,
                    unique: uniqueViewers.length,
                    trendPercent: viewTrendPercent,
                    trendDirection: viewTrendDelta < 0 ? 'down' : viewTrendDelta > 0 ? 'up' : 'stable',
                },
                searchAppearances: {
                    total: searchAppearancesTotal,
                    last7Days: searchAppearancesLast7Days,
                    last30Days: searchAppearancesLast30Days,
                },
                suggestionAppearances: {
                    total: suggestionAppearancesTotal,
                    last7Days: suggestionAppearancesLast7Days,
                    last30Days: suggestionAppearancesLast30Days,
                },
                profileSaves: {
                    total: savesTotal,
                    last7Days: savesLast7Days,
                    last30Days: savesLast30Days,
                },
                matchRate: {
                    value: matchRate,
                    display: formatPercent(matchRate),
                    connectionRequests: connectionRequestsLast30Days,
                    acceptedConnections: acceptedConnectionsLast30Days,
                    appearances: exposureLast30Days,
                },
            },
            matchInsights: {
                reasons,
                topTags,
            },
        };
    }

    /** Get leaderboard rankings */
    async getLeaderboard(params: LeaderboardParams) {
        return {
            period: params.period,
            scope: params.scope,
            leaderboard: [],
            updatedAt: new Date().toISOString(),
        };
    }

    /** Get stats for a group/circle */
    async getGroupStats(groupId: string, _userId?: string) {
        try {
            const group = await prisma.groups.findUnique({
                where: { id: groupId },
                include: { _count: { select: { members: true } } },
            });

            if (!group) return null;

            return {
                groupId,
                memberCount: group._count.members,
                name: group.name,
            };
        } catch {
            return null;
        }
    }

    /** Get stats for an event */
    async getEventStats(eventId: string, _userId?: string) {
        return {
            eventId,
            viewCount: 0,
            interestedCount: 0,
            attendeeCount: 0,
        };
    }

    /** Track an event view */
    async trackEventView(eventId: string, _viewerId?: string) {
        // Placeholder - log event view tracking
        console.log(`Event view tracked: ${eventId}`);
    }

    /** Get recent activity feed */
    async getActivityFeed(limit: number = 20, _minutes: number = 10) {
        return {
            activities: [],
            count: 0,
            limit,
        };
    }

    /** Record a user activity */
    async recordActivity(userId: string, activityType: string, metadata: Record<string, any>) {
        console.log(`Activity recorded: ${userId} - ${activityType}`, metadata);
    }

    /** Get trending items */
    async getTrendingItems(_type?: string, _city?: string, limit: number = 10) {
        return {
            items: [],
            limit,
            updatedAt: new Date().toISOString(),
        };
    }

    /** Get onboarding social proof stats */
    async getOnboardingStats(_college?: string) {
        const totalUsers = await prisma.user.count();
        return {
            totalUsers,
            recentSignups: Math.floor(Math.random() * 20) + 5,
            activeToday: Math.floor(Math.random() * 50) + 10,
        };
    }

    /** Update user heartbeat / last active status */
    async updateUserActivity(userId: string, _currentPage?: string) {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: { lastActiveAt: new Date() },
            });
        } catch (error) {
            console.error('Error updating user activity:', error);
        }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CRON METHODS (used by cron.service.ts)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    /** Run leaderboard calculation cron */
    async runLeaderboardCron() {
        console.log('🏆 Leaderboard cron executed');
        // TODO: Calculate and cache leaderboard rankings
    }

    /** Run trending detection cron */
    async runTrendingCron() {
        console.log('📈 Trending detection cron executed');
        // TODO: Detect trending profiles, posts, and skills
    }

    /** Cleanup old activity records */
    async cleanupOldActivities() {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30); // Keep 30 days
        console.log('🧹 Old activities cleanup executed');
        // TODO: Delete activity records older than cutoff
    }

    /** Cleanup old profile view records */
    async cleanupOldProfileViews() {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90); // Keep 90 days

        try {
            const deleted = await prisma.profile_views.deleteMany({
                where: { viewedAt: { lt: cutoff } },
            });
            console.log(`🧹 Cleaned up ${deleted.count} old profile views`);
        } catch (error) {
            console.error('Error cleaning up profile views:', error);
        }
    }

    /** Run onboarding stats cron */
    async runOnboardingCron() {
        console.log('📊 Onboarding stats cron executed');
        // TODO: Pre-calculate and cache onboarding social proof stats
    }
}

export const socialProofService = new SocialProofService();
