import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { prisma, prismaRead } from "../../../../config/prisma";
import { randomUUID } from "crypto";
import { ensureString } from "../../../../shared/utils/request.util";
import { canViewGroup } from "../../../../shared/utils/access-control.util";
import { Group, generateSlug, normalizeOptionalString, mergeCategoryIntoTags, normalizeStringList, invalidateGroupListCache, mapGroupPrivacy, GroupsResponse } from "./support.controller";
import { generateGroupInviteCode } from "./invitation-support.controller";
import { getEffectiveGroupRole, mapRoleToEnum } from "./roles.controller";

/**
 * Create a new group
 * POST /api/groups
 */
export const createGroup = async (
  req: AuthenticatedRequest,
  res: Response<Group | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { name, description, privacy, category, tags, rules, coverImage, iconImage } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 3) {
      res.status(400).json({ error: 'Group name must be at least 3 characters' });
      return;
    }

    const slug = generateSlug(name);
    const isPrivate = privacy === 'PRIVATE' || privacy === 'SECRET';
    const normalizedCategory = normalizeOptionalString(category);
    const normalizedTags = mergeCategoryIntoTags(normalizeStringList(tags), normalizedCategory);
    const normalizedRules = normalizeStringList(rules);

    const group = await prisma.groups.create({
      data: {
        id: randomUUID(),
        name: name.trim(),
        description: normalizeOptionalString(description),
        category: normalizedCategory,
        rules: normalizedRules,
        imageUrl: coverImage || iconImage || null,
        inviteCode: generateGroupInviteCode(),
        inviteLinkVisibility: 'ADMINS',
        inviteLinkUpdatedAt: new Date(),
        creatorId: userId,
        isPrivate,
        tags: normalizedTags,
        updatedAt: new Date(),
        group_members: {
          create: {
            id: randomUUID(),
            userId,
            role: 'owner',
          },
        },
      },
    });

    invalidateGroupListCache();
    res.status(201).json({
      id: group.id,
      name: group.name,
      slug,
      description: group.description,
      coverImage: group.coverImage ?? group.imageUrl,
      iconImage: group.iconImage ?? group.imageUrl,
      privacy: mapGroupPrivacy(group.isPrivate),
      category: group.category,
      tags: group.tags,
      rules: group.rules,
      memberCount: group.memberCount,
      postCount: 0,
      createdAt: group.createdAt.toISOString(),
      isMember: true,
      memberRole: 'OWNER',
      isAddedToMessages: false,
    });
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
};

/**
 * Get a single group
 * GET /api/groups/:identifier
 */
export const getGroup = async (
  req: AuthenticatedRequest,
  res: Response<Group | ErrorResponse>
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const identifier = ensureString(req.params.identifier);
    if (!identifier) {
      res.status(400).json({ error: 'Group identifier is required' });
      return;
    }

    const group = await prismaRead.groups.findFirst({
      where: {
        OR: [{ id: identifier }, { name: { equals: identifier, mode: 'insensitive' } }],
      },
      include: {
        group_members: userId ? { where: { userId } } : false,
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!(await canViewGroup(group, userId))) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const groupWithRelations = group as typeof group & { group_members: unknown[] };
    const memberRecord = userId && Array.isArray(groupWithRelations.group_members) ? groupWithRelations.group_members[0] : null;
    const memberRole = userId ? getEffectiveGroupRole(group, memberRecord as any, userId) : null;

    res.status(200).json({
      id: group.id,
      name: group.name,
      slug: generateSlug(group.name),
      description: group.description,
      coverImage: group.coverImage ?? group.imageUrl,
      iconImage: group.iconImage ?? group.imageUrl,
      privacy: mapGroupPrivacy(group.isPrivate),
      category: group.category,
      tags: group.tags,
      rules: group.rules,
      memberCount: group.memberCount,
      postCount: 0,
      createdAt: group.createdAt.toISOString(),
      isMember: !!memberRecord || memberRole === 'owner',
      memberRole: memberRole ? mapRoleToEnum(memberRole) : null,
      ...(userId ? { isAddedToMessages: Boolean((memberRecord as any)?.showInMessages) } : {}),
    });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
};

/**
 * Get user's groups
 * GET /api/groups/my
 */
export const getMyGroups = async (
  req: AuthenticatedRequest,
  res: Response<GroupsResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [memberships, total] = await Promise.all([
      prismaRead.group_members.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: {
          groups: true,
        },
      }),
      prismaRead.group_members.count({ where: { userId } }),
    ]);

    const groups: Group[] = memberships.map((m) => ({
      id: m.groups.id,
      name: m.groups.name,
      slug: generateSlug(m.groups.name),
      description: m.groups.description,
      coverImage: m.groups.coverImage ?? m.groups.imageUrl,
      iconImage: m.groups.iconImage ?? m.groups.imageUrl,
      privacy: mapGroupPrivacy(m.groups.isPrivate),
      category: m.groups.category,
      tags: m.groups.tags,
      rules: m.groups.rules,
      memberCount: m.groups.memberCount,
      postCount: 0,
      createdAt: m.groups.createdAt.toISOString(),
      isMember: true,
      memberRole: mapRoleToEnum(getEffectiveGroupRole(m.groups, m, userId) || m.role),
      isAddedToMessages: Boolean(m.showInMessages),
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
    console.error('Error fetching user groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
};
