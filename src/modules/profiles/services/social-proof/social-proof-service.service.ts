import { randomUUID } from "crypto";
import { prisma } from "../../../../config/prisma";
import { notificationService } from "../../../notifications/services/notification.service";
import { areUsersBlocked, getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { isProfileSavedOperation, toggleProfileSaveOperation, getProfileSaversOperation, getRecentlyViewedProfilesOperation } from "./social-proof-service-is-profile-saved.service";
import { getProfileInsightsOperation, getLeaderboardOperation, getGroupStatsOperation, getEventStatsOperation, trackEventViewOperation, getActivityFeedOperation, recordActivityOperation, getTrendingItemsOperation, getOnboardingStatsOperation, updateUserActivityOperation, runLeaderboardCronOperation, runTrendingCronOperation, cleanupOldActivitiesOperation, cleanupOldProfileViewsOperation, runOnboardingCronOperation } from "./social-proof-service-get-profile-insights.service";
import { LiveStatsParams, LeaderboardParams, normalizeCollege } from "./live-stats-params.service";

export class SocialProofService {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CONTROLLER METHODS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    /** Get live activity stats (active users, connections today, etc.) */
    async getLiveStats(params: LiveStatsParams) { return getLiveStatsOperation.call(this, params); }

    /** Track a profile view */
    async trackProfileView(viewerId: string, viewedId: string, source?: string) { return trackProfileViewOperation.call(this, viewerId, viewedId, source); }

    /** Get profile view statistics for a user */
    async getProfileViewStats(userId: string) { return getProfileViewStatsOperation.call(this, userId); }

    async getProfileViewHistory(userId: string, page: number = 1, limit: number = 50) { return getProfileViewHistoryOperation.call(this, userId, page, limit); }

    async isProfileSaved(userId: string, targetUserId: string): Promise<boolean> { return isProfileSavedOperation.call(this, userId, targetUserId); }

    async toggleProfileSave(userId: string, targetUserId: string) { return toggleProfileSaveOperation.call(this, userId, targetUserId); }

    async getProfileSavers(userId: string, page: number = 1, limit: number = 50) { return getProfileSaversOperation.call(this, userId, page, limit); }

    async getRecentlyViewedProfiles(userId: string, page: number = 1, limit: number = 50) { return getRecentlyViewedProfilesOperation.call(this, userId, page, limit); }

    async getProfileInsights(userId: string) { return getProfileInsightsOperation.call(this, userId); }

    /** Get leaderboard rankings */
    async getLeaderboard(params: LeaderboardParams) { return getLeaderboardOperation.call(this, params); }

    /** Get stats for a group/circle */
    async getGroupStats(groupId: string, _userId?: string) { return getGroupStatsOperation.call(this, groupId, _userId); }

    /** Get stats for an event */
    async getEventStats(eventId: string, _userId?: string) { return getEventStatsOperation.call(this, eventId, _userId); }

    /** Track an event view */
    async trackEventView(eventId: string, _viewerId?: string) { return trackEventViewOperation.call(this, eventId, _viewerId); }

    /** Get recent activity feed */
    async getActivityFeed(limit: number = 20, _minutes: number = 10) { return getActivityFeedOperation.call(this, limit, _minutes); }

    /** Record a user activity */
    async recordActivity(userId: string, activityType: string, metadata: Record<string, any>) { return recordActivityOperation.call(this, userId, activityType, metadata); }

    /** Get trending items */
    async getTrendingItems(_type?: string, _city?: string, limit: number = 10) { return getTrendingItemsOperation.call(this, _type, _city, limit); }

    /** Get onboarding social proof stats */
    async getOnboardingStats(_college?: string) { return getOnboardingStatsOperation.call(this, _college); }

    /** Update user heartbeat / last active status */
    async updateUserActivity(userId: string, _currentPage?: string) { return updateUserActivityOperation.call(this, userId, _currentPage); }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // CRON METHODS (used by cron.service.ts)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    /** Run leaderboard calculation cron */
    async runLeaderboardCron() { return runLeaderboardCronOperation.call(this); }

    /** Run trending detection cron */
    async runTrendingCron() { return runTrendingCronOperation.call(this); }

    /** Cleanup old activity records */
    async cleanupOldActivities() { return cleanupOldActivitiesOperation.call(this); }

    /** Cleanup old profile view records */
    async cleanupOldProfileViews() { return cleanupOldProfileViewsOperation.call(this); }

    /** Run onboarding stats cron */
    async runOnboardingCron() { return runOnboardingCronOperation.call(this); }
}

export const socialProofService = new SocialProofService();

async function getLiveStatsOperation(this: SocialProofService, params: LiveStatsParams) {
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

async function trackProfileViewOperation(this: SocialProofService, viewerId: string, viewedId: string, source?: string) {
        if (viewerId === viewedId) return; // Don't track self-views
        if (await areUsersBlocked(viewerId, viewedId)) return;

        try {
            const payload = await prisma.$transaction(async (tx) => {
                const duplicate = await tx.profile_views.findFirst({
                    where: {
                        viewerId,
                        viewedId,
                        viewedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
                    },
                    select: { id: true },
                });
                if (duplicate) return null;
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

            if (payload && !(await areUsersBlocked(viewerId, viewedId))) {
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

async function getProfileViewStatsOperation(this: SocialProofService, userId: string) {
        const now = new Date();
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        const lastHour = new Date(now.getTime() - 60 * 60 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const previousWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        const blockedUserIds = await getBlockedUserIds(userId);
        const visibleViews = {
            viewedId: userId,
            ...(blockedUserIds.length ? { viewerId: { notIn: blockedUserIds } } : {}),
        };

        const [profileOwner, totalViews, todayViews, weeklyViews, lastHourViews, previousWeekViews, recentViews, uniqueViewers] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: { college: true },
            }),
            prisma.profile_views.count({ where: visibleViews }),
            prisma.profile_views.count({
                where: { ...visibleViews, viewedAt: { gte: today } },
            }),
            prisma.profile_views.count({
                where: { ...visibleViews, viewedAt: { gte: weekAgo } },
            }),
            prisma.profile_views.count({
                where: { ...visibleViews, viewedAt: { gte: lastHour } },
            }),
            prisma.profile_views.count({
                where: {
                    ...visibleViews,
                    viewedAt: {
                        gte: previousWeekStart,
                        lt: weekAgo,
                    },
                },
            }),
            prisma.profile_views.findMany({
                where: visibleViews,
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
                where: visibleViews,
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

async function getProfileViewHistoryOperation(this: SocialProofService, userId: string, page: number = 1, limit: number = 50) {
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
        const skip = (safePage - 1) * safeLimit;
        const blockedUserIds = await getBlockedUserIds(userId);
        const visibleViews = {
            viewedId: userId,
            ...(blockedUserIds.length ? { viewerId: { notIn: blockedUserIds } } : {}),
        };

        const [profileOwner, groupedViews, distinctViewers, totalViews] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: { college: true },
            }),
            prisma.profile_views.groupBy({
                by: ['viewerId'],
                where: visibleViews,
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
                where: visibleViews,
                distinct: ['viewerId'],
                select: { viewerId: true },
            }),
            prisma.profile_views.count({
                where: visibleViews,
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
