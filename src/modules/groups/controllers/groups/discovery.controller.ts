import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prismaRead, prisma } from "../../../../config/prisma";
import { buildGroupVisibilityWhere } from "../../../../shared/utils/access-control.util";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { normalizeGroupListQueryValue, GroupsResponse, Group, generateSlug, mapGroupPrivacy, GROUP_LIST_CACHE_TAG, GROUP_LIST_CACHE_SOFT_TTL_SECONDS, GROUP_LIST_CACHE_HARD_TTL_SECONDS } from "./support.controller";
import { getEffectiveGroupRole, mapRoleToEnum } from "./roles.controller";

export const buildAnonymousGroupListCacheKey = (params: {
  page: number;
  limit: number;
  search?: string;
  category?: string;
  privacy?: string;
}): string => {
  const search = normalizeGroupListQueryValue(params.search).toLowerCase();
  const category = normalizeGroupListQueryValue(params.category);
  const privacy = normalizeGroupListQueryValue(params.privacy, 20).toUpperCase();
  return [
    'groups:list:v2',
    params.page,
    params.limit,
    encodeURIComponent(search),
    encodeURIComponent(category),
    encodeURIComponent(privacy),
  ].join(':');
};

/**
 * Discover groups
 * GET /api/groups/discover
 */
export const discoverGroups = async (
  req: AuthenticatedRequest,
  res: Response<GroupsResponse | ErrorResponse>
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search as string | undefined;
    const category = req.query.category as string | undefined;

    let userGroupIds: string[] = [];
    if (userId) {
      const memberships = await prismaRead.group_members.findMany({
        where: { userId },
        select: { groupId: true },
      });
      userGroupIds = memberships.map((m) => m.groupId);
    }

    const filters: any[] = [{ isPrivate: false }];

    if (userGroupIds.length > 0) {
      filters.push({ id: { notIn: userGroupIds } });
    }

    if (search) {
      filters.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (category) {
      filters.push({
        OR: [
          { category: { equals: category, mode: 'insensitive' } },
          { tags: { has: category } },
        ],
      });
    }

    const where: any = { AND: filters };

    const [groupsList, total] = await Promise.all([
      prismaRead.groups.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ memberCount: 'desc' }, { id: 'asc' }],
      }),
      prismaRead.groups.count({ where }),
    ]);

    const groups: Group[] = groupsList.map((g) => ({
      id: g.id,
      name: g.name,
      slug: generateSlug(g.name),
      description: g.description,
      coverImage: g.coverImage ?? g.imageUrl,
      iconImage: g.iconImage ?? g.imageUrl,
      privacy: mapGroupPrivacy(g.isPrivate),
      category: g.category,
      tags: g.tags,
      rules: g.rules,
      memberCount: g.memberCount,
      postCount: 0,
      createdAt: g.createdAt.toISOString(),
      isMember: false,
      memberRole: null,
      ...(userId ? { isAddedToMessages: false } : {}),
    }));

    res.status(200).json({
      groups,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error discovering groups:', error);
    res.status(500).json({ error: 'Failed to discover groups' });
  }
};

/**
 * Get group categories
 * GET /api/groups/categories
 */
export const getCategories = async (
  _req: AuthenticatedRequest,
  res: Response<{ name: string; count: number }[] | ErrorResponse>
): Promise<void> => {
  try {
    const groups = await prisma.groups.findMany({
      where: { isPrivate: false },
      select: { category: true, tags: true },
    });

    const tagCounts: { [key: string]: number } = {};
    groups.forEach((g) => {
      const groupCategories = Array.from(new Set([g.category, ...g.tags].filter(Boolean) as string[]));
      groupCategories.forEach((tag) => {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
    });

    const categories = Object.entries(tagCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.status(200).json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

/**
 * List all groups (search/filter)
 * GET /api/groups
 */
export const listGroups = async (
  req: AuthenticatedRequest,
  res: Response<GroupsResponse | ErrorResponse>
): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;
    const search = normalizeGroupListQueryValue(req.query.search) || undefined;
    const category = normalizeGroupListQueryValue(req.query.category) || undefined;
    const privacy = normalizeGroupListQueryValue(req.query.privacy, 20).toUpperCase() || undefined;
    const userId = req.user?.userId ? String(req.user.userId) : null;

    const filters: any[] = [await buildGroupVisibilityWhere(userId)];

    if (search) {
      filters.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (category) {
      filters.push({
        OR: [
          { category: { equals: category, mode: 'insensitive' } },
          { tags: { has: category } },
        ],
      });
    }

    if (privacy === 'PUBLIC') {
      filters.push({ isPrivate: false });
    } else if (privacy === 'PRIVATE' || privacy === 'SECRET') {
      filters.push({ isPrivate: true });
    }

    const where: any = { AND: filters };

    const computeResponse = async (): Promise<GroupsResponse> => {
      const [groupsList, total] = await Promise.all([
        prismaRead.groups.findMany({
          where,
          skip,
          take: limit,
          orderBy: [{ memberCount: 'desc' }, { id: 'asc' }],
          include: {
            group_members: userId
              ? { where: { userId }, select: { role: true, showInMessages: true } }
              : false,
          },
        }),
        prismaRead.groups.count({ where }),
      ]);

      const groups: Group[] = groupsList.map((g) => {
        const groupWithMembership = g as typeof g & {
          group_members?: Array<{ role: string; showInMessages: boolean }>;
        };
        const memberRecord = Array.isArray(groupWithMembership.group_members)
          ? groupWithMembership.group_members[0]
          : null;
        const memberRole = userId ? getEffectiveGroupRole(g, memberRecord, userId) : null;

        return {
          id: g.id,
          name: g.name,
          slug: generateSlug(g.name),
          description: g.description,
          coverImage: g.coverImage ?? g.imageUrl,
          iconImage: g.iconImage ?? g.imageUrl,
          privacy: mapGroupPrivacy(g.isPrivate),
          category: g.category,
          tags: g.tags,
          rules: g.rules,
          memberCount: g.memberCount,
          postCount: 0,
          createdAt: g.createdAt.toISOString(),
          isMember: Boolean(memberRecord) || memberRole === 'owner',
          memberRole: memberRole ? mapRoleToEnum(memberRole) : null,
          ...(userId ? { isAddedToMessages: Boolean(memberRecord?.showInMessages) } : {}),
        };
      });

      return {
        groups,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    };

    const response = userId
      ? await computeResponse()
      : await cacheService.getOrSet(
          buildAnonymousGroupListCacheKey({ page, limit, search, category, privacy }),
          computeResponse,
          {
            tags: [GROUP_LIST_CACHE_TAG],
            swr: {
              softTtlSeconds: GROUP_LIST_CACHE_SOFT_TTL_SECONDS,
              hardTtlSeconds: GROUP_LIST_CACHE_HARD_TTL_SECONDS,
            },
          }
        );

    if (!userId) {
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=90');
      res.vary('Authorization');
      res.vary('Cookie');
    }
    res.status(200).json(response);
  } catch (error) {
    console.error('Error listing groups:', error);
    res.status(500).json({ error: 'Failed to list groups' });
  }
};
