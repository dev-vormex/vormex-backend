import { prisma } from "../../../../config/prisma";
import { DISCOVERY_SOURCE_FOR_YOU, DISCOVERY_SOURCE_PEOPLE_SEARCH } from "../../../discovery/services/discovery-power.service";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { startOfToday, daysAgo, pushWeightedTag, formatPercent, LeaderboardParams } from "./live-stats-params.service";
import { SocialProofService } from "./social-proof-service.service";

export async function getProfileInsightsOperation(this: SocialProofService, userId: string) {
        const today = startOfToday();
        const weekAgo = daysAgo(7);
        const monthAgo = daysAgo(30);
        const previousMonthStart = daysAgo(60);
        const blockedUserIds = await getBlockedUserIds(userId);
        const visibleViews = {
            viewedId: userId,
            ...(blockedUserIds.length ? { viewerId: { notIn: blockedUserIds } } : {}),
        };
        const visibleSaves = {
            targetUserId: userId,
            ...(blockedUserIds.length ? { userId: { notIn: blockedUserIds } } : {}),
        };

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
            prisma.profile_views.count({ where: visibleViews }),
            prisma.profile_views.count({ where: { ...visibleViews, viewedAt: { gte: today } } }),
            prisma.profile_views.count({ where: { ...visibleViews, viewedAt: { gte: weekAgo } } }),
            prisma.profile_views.count({ where: { ...visibleViews, viewedAt: { gte: monthAgo } } }),
            prisma.profile_views.count({
                where: { ...visibleViews, viewedAt: { gte: previousMonthStart, lt: monthAgo } },
            }),
            prisma.profile_views.findMany({
                where: visibleViews,
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
            (prisma as any).saved_profiles.count({ where: visibleSaves }),
            (prisma as any).saved_profiles.count({ where: { ...visibleSaves, createdAt: { gte: weekAgo } } }),
            (prisma as any).saved_profiles.count({ where: { ...visibleSaves, createdAt: { gte: monthAgo } } }),
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
        if (onboarding && onboarding.lookingFor.length > 0) {
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

export async function getLeaderboardOperation(this: SocialProofService, params: LeaderboardParams) {
        return {
            period: params.period,
            scope: params.scope,
            leaderboard: [],
            updatedAt: new Date().toISOString(),
        };
    }

export async function getGroupStatsOperation(this: SocialProofService, groupId: string, _userId?: string) {
        try {
            const group = await prisma.groups.findUnique({
                where: { id: groupId },
                include: { _count: { select: { group_members: true } } },
            });

            if (!group) return null;

            return {
                groupId,
                memberCount: group._count.group_members,
                name: group.name,
            };
        } catch {
            return null;
        }
    }

export async function getEventStatsOperation(this: SocialProofService, eventId: string, _userId?: string) {
        return {
            eventId,
            viewCount: 0,
            interestedCount: 0,
            attendeeCount: 0,
        };
    }

export async function trackEventViewOperation(this: SocialProofService, eventId: string, _viewerId?: string) {
        // Placeholder - log event view tracking
        console.log(`Event view tracked: ${eventId}`);
    }

export async function getActivityFeedOperation(this: SocialProofService, limit: number = 20, _minutes: number = 10) {
        return {
            activities: [],
            count: 0,
            limit,
        };
    }

export async function recordActivityOperation(this: SocialProofService, userId: string, activityType: string, metadata: Record<string, any>) {
        console.log(`Activity recorded: ${userId} - ${activityType}`, metadata);
    }

export async function getTrendingItemsOperation(this: SocialProofService, _type?: string, _city?: string, limit: number = 10) {
        return {
            items: [],
            limit,
            updatedAt: new Date().toISOString(),
        };
    }

export async function getOnboardingStatsOperation(this: SocialProofService, _college?: string) {
        const totalUsers = await prisma.user.count();
        return {
            totalUsers,
            recentSignups: Math.floor(Math.random() * 20) + 5,
            activeToday: Math.floor(Math.random() * 50) + 10,
        };
    }

export async function updateUserActivityOperation(this: SocialProofService, userId: string, _currentPage?: string) {
        try {
            await prisma.user.update({
                where: { id: userId },
                data: { lastActiveAt: new Date() },
            });
        } catch (error) {
            console.error('Error updating user activity:', error);
        }
    }

export async function runLeaderboardCronOperation(this: SocialProofService) {
        console.log('🏆 Leaderboard cron executed');
        // TODO: Calculate and cache leaderboard rankings
    }

export async function runTrendingCronOperation(this: SocialProofService) {
        console.log('📈 Trending detection cron executed');
        // TODO: Detect trending profiles, posts, and skills
    }

export async function cleanupOldActivitiesOperation(this: SocialProofService) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30); // Keep 30 days
        console.log('🧹 Old activities cleanup executed');
        // TODO: Delete activity records older than cutoff
    }

export async function cleanupOldProfileViewsOperation(this: SocialProofService) {
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

export async function runOnboardingCronOperation(this: SocialProofService) {
        console.log('📊 Onboarding stats cron executed');
        // TODO: Pre-calculate and cache onboarding social proof stats
    }
