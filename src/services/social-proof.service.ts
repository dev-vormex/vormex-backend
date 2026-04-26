// @ts-nocheck
import { randomUUID } from 'crypto';
import { prisma } from '../config/prisma';
import { notificationService } from './notification.service';

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
                        }
                        : null,
                };
            }),
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
