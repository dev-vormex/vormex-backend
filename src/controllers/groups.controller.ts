import { Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { imageProcessingService } from '../services/image-processing.service';
import { bunnyStorageService } from '../services/bunny-storage.service';

type GroupPrivacy = 'PUBLIC' | 'PRIVATE' | 'SECRET';
type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';

interface GroupUser {
  id: string;
  name: string;
  username: string;
  profileImage: string | null;
  headline?: string | null;
}

interface Group {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  coverImage: string | null;
  iconImage: string | null;
  privacy: GroupPrivacy;
  category: string | null;
  tags: string[];
  memberCount: number;
  postCount: number;
  createdAt: string;
  isMember: boolean;
  memberRole: GroupMemberRole | null;
}

interface GroupsResponse {
  groups: Group[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface GroupInvite {
  id: string;
  groupId: string;
  invitedUserId: string;
  invitedById: string;
  status: string;
  message: string | null;
  createdAt: string;
  invitedBy: GroupUser;
  group: {
    id: string;
    name: string;
    slug: string;
    iconImage: string | null;
    privacy: GroupPrivacy;
    memberCount: number;
  };
}

const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
};

const mapGroupPrivacy = (isPrivate: boolean): GroupPrivacy => {
  return isPrivate ? 'PRIVATE' : 'PUBLIC';
};

const mapRoleToEnum = (role: string): GroupMemberRole => {
  const roleMap: { [key: string]: GroupMemberRole } = {
    admin: 'ADMIN',
    moderator: 'MODERATOR',
    member: 'MEMBER',
    owner: 'OWNER',
  };
  return roleMap[role.toLowerCase()] || 'MEMBER';
};

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
    const { name, description, privacy, category, tags, coverImage, iconImage } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 3) {
      res.status(400).json({ error: 'Group name must be at least 3 characters' });
      return;
    }

    const slug = generateSlug(name);
    const isPrivate = privacy === 'PRIVATE' || privacy === 'SECRET';

    const group = await prisma.groups.create({
      data: {
        id: randomUUID(),
        name: name.trim(),
        description: description || null,
        imageUrl: coverImage || iconImage || null,
        creatorId: userId,
        isPrivate,
        tags: tags || [],
        updatedAt: new Date(),
        group_members: {
          create: {
            id: randomUUID(),
            userId,
            role: 'admin',
          },
        },
      },
      include: {
        users: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
        _count: { select: { group_members: true } },
      },
    });

    res.status(201).json({
      id: group.id,
      name: group.name,
      slug,
      description: group.description,
      coverImage: group.coverImage ?? group.imageUrl,
      iconImage: group.iconImage ?? group.imageUrl,
      privacy: mapGroupPrivacy(group.isPrivate),
      category: category || null,
      tags: group.tags,
      memberCount: group._count.group_members,
      postCount: 0,
      createdAt: group.createdAt.toISOString(),
      isMember: true,
      memberRole: 'OWNER',
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

    const group = await prisma.groups.findFirst({
      where: {
        OR: [{ id: identifier }, { name: { equals: identifier, mode: 'insensitive' } }],
      },
      include: {
        users: {
          select: { id: true, name: true, username: true, profileImage: true },
        },
        group_members: userId ? { where: { userId } } : false,
        _count: { select: { group_members: true } },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const groupWithRelations = group as typeof group & { group_members: unknown[]; _count: { group_members: number } };
    const memberRecord = userId && Array.isArray(groupWithRelations.group_members) ? groupWithRelations.group_members[0] : null;

    res.status(200).json({
      id: group.id,
      name: group.name,
      slug: generateSlug(group.name),
      description: group.description,
      coverImage: group.coverImage ?? group.imageUrl,
      iconImage: group.iconImage ?? group.imageUrl,
      privacy: mapGroupPrivacy(group.isPrivate),
      category: null,
      tags: group.tags,
      memberCount: groupWithRelations._count.group_members,
      postCount: 0,
      createdAt: group.createdAt.toISOString(),
      isMember: !!memberRecord,
      memberRole: memberRecord ? mapRoleToEnum(memberRecord.role) : null,
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
      prisma.group_members.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
        include: {
          groups: {
            include: {
              users: {
                select: { id: true, name: true, username: true, profileImage: true },
              },
              _count: { select: { group_members: true } },
            },
          },
        },
      }),
      prisma.group_members.count({ where: { userId } }),
    ]);

    const groups: Group[] = memberships.map((m) => ({
      id: m.groups.id,
      name: m.groups.name,
      slug: generateSlug(m.groups.name),
      description: m.groups.description,
      coverImage: m.groups.coverImage ?? m.groups.imageUrl,
      iconImage: m.groups.iconImage ?? m.groups.imageUrl,
      privacy: mapGroupPrivacy(m.groups.isPrivate),
      category: null,
      tags: m.groups.tags,
      memberCount: m.groups._count.group_members,
      postCount: 0,
      createdAt: m.groups.createdAt.toISOString(),
      isMember: true,
      memberRole: mapRoleToEnum(m.role),
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
      const memberships = await prisma.group_members.findMany({
        where: { userId },
        select: { groupId: true },
      });
      userGroupIds = memberships.map((m) => m.groupId);
    }

    const where: any = {
      isPrivate: false,
    };

    if (userGroupIds.length > 0) {
      where.id = { notIn: userGroupIds };
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.tags = { has: category };
    }

    const [groupsList, total] = await Promise.all([
      prisma.groups.findMany({
        where,
        skip,
        take: limit,
        orderBy: { memberCount: 'desc' },
        include: {
          users: {
            select: { id: true, name: true, username: true, profileImage: true },
          },
          _count: { select: { group_members: true } },
        },
      }),
      prisma.groups.count({ where }),
    ]);

    const groups: Group[] = groupsList.map((g) => ({
      id: g.id,
      name: g.name,
      slug: generateSlug(g.name),
      description: g.description,
      coverImage: g.coverImage ?? g.imageUrl,
      iconImage: g.iconImage ?? g.imageUrl,
      privacy: mapGroupPrivacy(g.isPrivate),
      category: null,
      tags: g.tags,
      memberCount: g._count.group_members,
      postCount: 0,
      createdAt: g.createdAt.toISOString(),
      isMember: false,
      memberRole: null,
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
 * Get pending invites for the current user
 * GET /api/groups/invites/pending
 */
export const getUserPendingInvites = async (
  req: AuthenticatedRequest,
  res: Response<{ invites: GroupInvite[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Since we don't have a GroupInvite model in the schema, return empty array for now
    // This would need a proper model to be added to the Prisma schema
    res.status(200).json({ invites: [] });
  } catch (error) {
    console.error('Error fetching pending invites:', error);
    res.status(500).json({ error: 'Failed to fetch pending invites' });
  }
};

/**
 * Join a group
 * POST /api/groups/:groupId/join
 */
export const joinGroup = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      include: {
        group_members: { where: { userId } },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const groupWithMembers = group as typeof group & { group_members: unknown[] };
    if (groupWithMembers.group_members.length > 0) {
      res.status(400).json({ error: 'Already a member of this group' });
      return;
    }

    if (group.memberCount >= group.maxMembers) {
      res.status(400).json({ error: 'Group is full' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.create({
        data: {
          id: randomUUID(),
          groupId,
          userId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
    ]);

    res.status(200).json({
      status: group.isPrivate ? 'pending' : 'joined',
      message: group.isPrivate ? 'Join request sent' : 'Successfully joined the group',
    });
  } catch (error) {
    console.error('Error joining group:', error);
    res.status(500).json({ error: 'Failed to join group' });
  }
};

/**
 * Leave a group
 * POST /api/groups/:groupId/leave
 */
export const leaveGroup = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const membership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    if (!membership) {
      res.status(400).json({ error: 'Not a member of this group' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.delete({
        where: { groupId_userId: { groupId, userId } },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { decrement: 1 }, updatedAt: new Date() },
      }),
    ]);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error leaving group:', error);
    res.status(500).json({ error: 'Failed to leave group' });
  }
};

/**
 * Get group members
 * GET /api/groups/:groupId/members
 */
export const getGroupMembers = async (
  req: AuthenticatedRequest,
  res: Response<{ members: any[]; pagination: any } | ErrorResponse>
): Promise<void> => {
  try {
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const page = Math.max(1, parseInt(ensureString(req.query.page) || '1') || 1);
    const limit = Math.min(50, Math.max(1, parseInt(ensureString(req.query.limit) || '20') || 20));
    const skip = (page - 1) * limit;
    const role = ensureString(req.query.role);
    const search = ensureString(req.query.search);

    const where: any = { groupId };
    if (role) {
      where.role = role.toLowerCase();
    }

    const [members, total] = await Promise.all([
      prisma.group_members.findMany({
        where,
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
      }),
      prisma.group_members.count({ where }),
    ]);

    // Fetch user data separately since there's no direct relation
    const userIds = members.map((m) => m.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, username: true, profileImage: true, headline: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    const membersWithUsers = members
      .filter((m) => {
        if (!search) return true;
        const user = userMap.get(m.userId);
        if (!user) return false;
        return (
          user.name.toLowerCase().includes(search.toLowerCase()) ||
          user.username.toLowerCase().includes(search.toLowerCase())
        );
      })
      .map((m) => ({
        id: m.id,
        groupId: m.groupId,
        userId: m.userId,
        user: userMap.get(m.userId) || { id: m.userId, name: 'Unknown', username: 'unknown', profileImage: null },
        role: mapRoleToEnum(m.role),
        joinedAt: m.joinedAt.toISOString(),
        mutedUntil: null,
      }));

    res.status(200).json({
      members: membersWithUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching group members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
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
      select: { tags: true },
    });

    const tagCounts: { [key: string]: number } = {};
    groups.forEach((g) => {
      g.tags.forEach((tag) => {
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
 * Get group posts
 * GET /api/groups/:groupId/posts
 */
export const getGroupPosts = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    const { groupId } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const pinnedFirst = req.query.pinnedFirst === 'true';

    // For now, return empty posts since there's no GroupPost model
    // You can add a GroupPost model to the schema later
    res.status(200).json({
      posts: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
    });
  } catch (error) {
    console.error('Error fetching group posts:', error);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
};

/**
 * Create a group post
 * POST /api/groups/:groupId/posts
 */
export const createGroupPost = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const { content, mediaUrls, mediaType } = req.body;

    // For now, return a mock response
    // You can add a GroupPost model to the schema later
    res.status(201).json({
      id: `post-${Date.now()}`,
      groupId,
      authorId: req.user.userId,
      content,
      mediaUrls: mediaUrls || [],
      mediaType,
      likesCount: 0,
      commentsCount: 0,
      isPinned: false,
      isApproved: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error creating group post:', error);
    res.status(500).json({ error: 'Failed to create post' });
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
    const search = req.query.search as string | undefined;
    const category = req.query.category as string | undefined;
    const privacy = req.query.privacy as string | undefined;

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (category) {
      where.tags = { has: category };
    }

    if (privacy === 'PUBLIC') {
      where.isPrivate = false;
    } else if (privacy === 'PRIVATE' || privacy === 'SECRET') {
      where.isPrivate = true;
    }

    const [groupsList, total] = await Promise.all([
      prisma.groups.findMany({
        where,
        skip,
        take: limit,
        orderBy: { memberCount: 'desc' },
        include: {
          users: {
            select: { id: true, name: true, username: true, profileImage: true },
          },
          _count: { select: { group_members: true } },
        },
      }),
      prisma.groups.count({ where }),
    ]);

    const groups: Group[] = groupsList.map((g) => ({
      id: g.id,
      name: g.name,
      slug: generateSlug(g.name),
      description: g.description,
      coverImage: g.coverImage ?? g.imageUrl,
      iconImage: g.iconImage ?? g.imageUrl,
      privacy: mapGroupPrivacy(g.isPrivate),
      category: null,
      tags: g.tags,
      memberCount: g._count.group_members,
      postCount: 0,
      createdAt: g.createdAt.toISOString(),
      isMember: false,
      memberRole: null,
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
    console.error('Error listing groups:', error);
    res.status(500).json({ error: 'Failed to list groups' });
  }
};

/**
 * Update a group
 * PUT /api/groups/:groupId
 */
export const updateGroup = async (
  req: AuthenticatedRequest,
  res: Response<Group | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const { name, description, privacy, category, tags, coverImage, iconImage, rules } = req.body;

    const membership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    if (!membership || !['admin', 'owner'].includes(membership.role)) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const updateData: any = {};
    if (name) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description;
    if (privacy) updateData.isPrivate = privacy === 'PRIVATE' || privacy === 'SECRET';
    if (tags) updateData.tags = tags;
    if (coverImage) updateData.coverImage = coverImage;
    if (iconImage) updateData.iconImage = iconImage;

    const updateDataWithTimestamp = { ...updateData, updatedAt: new Date() };
    const group = await prisma.groups.update({
      where: { id: groupId },
      data: updateDataWithTimestamp,
      include: {
        _count: { select: { group_members: true } },
      },
    });

    const groupWithCount = group as typeof group & { _count: { group_members: number } };
    res.status(200).json({
      id: group.id,
      name: group.name,
      slug: generateSlug(group.name),
      description: group.description,
      coverImage: group.coverImage ?? group.imageUrl,
      iconImage: group.iconImage ?? group.imageUrl,
      privacy: mapGroupPrivacy(group.isPrivate),
      category: category || null,
      tags: group.tags,
      memberCount: groupWithCount._count.group_members,
      postCount: 0,
      createdAt: group.createdAt.toISOString(),
      isMember: true,
      memberRole: mapRoleToEnum(membership.role),
    });
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
};

/**
 * Delete a group
 * DELETE /api/groups/:groupId
 */
export const deleteGroup = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (group.creatorId !== userId) {
      res.status(403).json({ error: 'Only the creator can delete this group' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.deleteMany({ where: { groupId } }),
      prisma.groups.delete({ where: { id: groupId } }),
    ]);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
};

/**
 * Upload group icon
 * POST /api/groups/:groupId/upload/icon
 */
export const uploadGroupIcon = async (
  req: AuthenticatedRequest,
  res: Response<{ iconUrl: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const rawGroupId = ensureString(req.params.groupId);
    if (!rawGroupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const membership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId: rawGroupId, userId } },
    });
    if (!membership || !['admin', 'owner'].includes(membership.role)) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error ?? 'Invalid image' });
      return;
    }

    const processedBuffer = await imageProcessingService.processProfilePicture(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadGroupIcon(processedBuffer, rawGroupId!);

    await prisma.groups.update({
      where: { id: rawGroupId! },
      data: { iconImage: cdnUrl, updatedAt: new Date() },
    });

    res.json({ iconUrl: cdnUrl });
  } catch (error: any) {
    console.error('Upload group icon error:', error);
    res.status(500).json({ error: 'Failed to upload group icon' });
  }
};

/**
 * Upload group cover
 * POST /api/groups/:groupId/upload/cover
 */
export const uploadGroupCover = async (
  req: AuthenticatedRequest,
  res: Response<{ coverUrl: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const rawGroupId = ensureString(req.params.groupId);
    if (!rawGroupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const membership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId: rawGroupId, userId } },
    });
    if (!membership || !['admin', 'owner'].includes(membership.role)) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const validation = imageProcessingService.validateImage(req.file.buffer, 10);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error ?? 'Invalid image' });
      return;
    }

    const processedBuffer = await imageProcessingService.processBannerImage(req.file.buffer);
    const cdnUrl = await bunnyStorageService.uploadGroupCover(processedBuffer, rawGroupId!);

    await prisma.groups.update({
      where: { id: rawGroupId! },
      data: { coverImage: cdnUrl, updatedAt: new Date() },
    });

    res.json({ coverUrl: cdnUrl });
  } catch (error: any) {
    console.error('Upload group cover error:', error);
    res.status(500).json({ error: 'Failed to upload group cover' });
  }
};

/**
 * Update member role
 * PUT /api/groups/:groupId/members/:userId
 */
export const updateMemberRole = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const userId = ensureString(req.params.userId);
    if (!groupId || !userId) {
      res.status(400).json({ error: 'Group ID and User ID are required' });
      return;
    }
    const { role } = req.body;

    const currentMembership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId: currentUserId } },
    });

    if (!currentMembership || !['admin', 'owner'].includes(currentMembership.role)) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: { role: role.toLowerCase() },
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
};

/**
 * Remove member from group
 * DELETE /api/groups/:groupId/members/:userId
 */
export const removeMember = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const currentUserId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const userId = ensureString(req.params.userId);
    if (!groupId || !userId) {
      res.status(400).json({ error: 'Group ID and User ID are required' });
      return;
    }

    const currentMembership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId: currentUserId } },
    });

    if (!currentMembership || !['admin', 'owner', 'moderator'].includes(currentMembership.role)) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.delete({
        where: { groupId_userId: { groupId, userId } },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { decrement: 1 }, updatedAt: new Date() },
      }),
    ]);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

/**
 * Get group messages
 * GET /api/groups/:groupId/messages
 */
export const getGroupMessages = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const limit = parseInt(ensureString(req.query.limit) || '50') || 50;
    const before = ensureString(req.query.before);

    // Verify user is member of group
    const membership = await prisma.group_members.findUnique({
      where: {
        groupId_userId: { groupId, userId: String(req.user.userId) },
      },
    });

    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const whereClause: any = { groupId, isDeleted: false };
    if (before) {
      whereClause.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.group_messages.findMany({
      where: whereClause,
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
          },
        },
        group_messages: {
          select: {
            id: true,
            content: true,
            senderId: true,
            users: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        group_message_reactions: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Return in chronological order (oldest first for display)
    const formatted = messages.reverse().map(msg => ({
      id: msg.id,
      groupId: msg.groupId,
      senderId: msg.senderId,
      sender: msg.users,
      content: msg.content,
      contentType: msg.contentType,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      replyToId: msg.replyToId,
      replyTo: msg.group_messages ? { id: msg.group_messages.id, content: msg.group_messages.content, senderId: msg.group_messages.senderId, sender: msg.group_messages.users } : null,
      reactions: msg.group_message_reactions,
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString(),
    }));

    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching group messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
};

/**
 * Send group message
 * POST /api/groups/:groupId/messages
 */
export const sendGroupMessage = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupId = String(req.params.groupId);
    const { content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId } = req.body;

    // Verify user is member of group
    const membership = await prisma.group_members.findUnique({
      where: {
        groupId_userId: { groupId, userId: String(req.user.userId) },
      },
    });

    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    // Create message in database
    const message = await prisma.group_messages.create({
      data: {
        id: randomUUID(),
        groupId,
        senderId: String(req.user.userId),
        content: content || '',
        contentType: contentType || 'text',
        mediaUrl,
        mediaType,
        fileName,
        fileSize,
        replyToId: replyToId != null ? String(replyToId) : undefined,
        updatedAt: new Date(),
      },
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
          },
        },
        group_messages: {
          select: {
            id: true,
            content: true,
            senderId: true,
          },
        },
      },
    });

    const msg = message as typeof message & { users: unknown; group_messages: unknown };
    res.status(201).json({
      id: msg.id,
      groupId: msg.groupId,
      senderId: msg.senderId,
      sender: msg.users,
      content: msg.content,
      contentType: msg.contentType,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      replyToId: msg.replyToId,
      replyTo: msg.group_messages,
      reactions: [],
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error('Error sending group message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};
