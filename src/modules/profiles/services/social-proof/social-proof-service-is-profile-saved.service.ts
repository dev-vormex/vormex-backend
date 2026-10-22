import { randomUUID } from "crypto";
import { prisma } from "../../../../config/prisma";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { assertUsersCanInteract, areUsersBlocked, getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { SocialProofService } from "./social-proof-service.service";
import { mapProfileInsightPerson } from "./live-stats-params.service";

export async function isProfileSavedOperation(this: SocialProofService, userId: string, targetUserId: string): Promise<boolean> {
        if (!userId || !targetUserId || userId === targetUserId) return false;
        if (await areUsersBlocked(userId, targetUserId)) return false;
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

export async function toggleProfileSaveOperation(this: SocialProofService, userId: string, targetUserId: string) {
        if (!targetUserId || targetUserId === userId) {
            throw new Error('Invalid target user');
        }
        await assertUsersCanInteract(userId, targetUserId, 'profile save');

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

export async function getProfileSaversOperation(this: SocialProofService, userId: string, page: number = 1, limit: number = 50) {
        const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
        const skip = (safePage - 1) * safeLimit;
        const blockedUserIds = await getBlockedUserIds(userId);
        const visibleSaves = {
            targetUserId: userId,
            ...(blockedUserIds.length ? { userId: { notIn: blockedUserIds } } : {}),
        };

        const [rows, totalCount] = await Promise.all([
            (prisma as any).saved_profiles.findMany({
                where: visibleSaves,
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
            (prisma as any).saved_profiles.count({ where: visibleSaves }),
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

export async function getRecentlyViewedProfilesOperation(this: SocialProofService, userId: string, page: number = 1, limit: number = 50) {
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
