import { Response } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma, prismaRead } from '../config/prisma';
import { ensureString } from '../utils/request.util';
import { imageProcessingService } from '../services/image-processing.service';
import { bunnyStorageService } from '../services/bunny-storage.service';
import { pushNotificationService } from '../services/push-notification.service';
import { cacheService } from '../services/cache.service';
import { getIO } from '../sockets';
import { buildGroupVisibilityWhere, canViewGroup } from '../utils/access-control.util';
import {
  areUsersBlocked,
  assertUsersCanInteract,
  getBlockedUserIds,
  safetyErrorResponse,
} from '../services/trust-safety.service';

type GroupPrivacy = 'PUBLIC' | 'PRIVATE' | 'SECRET';
type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
type InviteLinkVisibility = 'ADMINS' | 'MEMBERS';
type GroupInviteAction = 'accept' | 'decline';

const GROUP_INVITE_EXPIRES_MS = 3 * 24 * 60 * 60 * 1000;
const GROUP_INVITE_BASE_URL = (process.env.FRONTEND_URL || 'https://vormex.in').replace(/\/+$/, '');
const GROUP_LIST_CACHE_TAG = 'groups:list';
const GROUP_LIST_CACHE_SOFT_TTL_SECONDS = 30;
const GROUP_LIST_CACHE_HARD_TTL_SECONDS = 120;

interface GroupUser {
  id: string;
  name: string;
  username: string;
  profileImage: string | null;
  headline?: string | null;
  verified?: boolean;
  isVerified?: boolean;
  profileBadgeStyle?: string | null;
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
  rules: string[];
  memberCount: number;
  postCount: number;
  createdAt: string;
  isMember: boolean;
  memberRole: GroupMemberRole | null;
  isAddedToMessages?: boolean;
}

interface GroupShortcutLatestMessage {
  id: string;
  content: string;
  contentType: string;
  preview: string;
  senderId: string;
  senderName: string;
  createdAt: string;
}

interface GroupMessageShortcut {
  id: string;
  groupId: string;
  name: string;
  slug: string;
  description: string | null;
  coverImage: string | null;
  iconImage: string | null;
  privacy: GroupPrivacy;
  memberCount: number;
  memberRole: GroupMemberRole | null;
  addedAt: string;
  lastActivityAt: string;
  latestMessage: GroupShortcutLatestMessage | null;
  isAddedToMessages: boolean;
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

const normalizeGroupListQueryValue = (value: unknown, maxLength = 80): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

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

function invalidateGroupListCache(): void {
  void cacheService.invalidateTags(GROUP_LIST_CACHE_TAG).catch((error: unknown) => {
    console.error('Failed to invalidate group list cache:', error);
  });
}

interface GroupInvite {
  id: string;
  groupId: string;
  invitedUserId: string;
  invitedById: string;
  status: string;
  message: string | null;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  invitedUser?: GroupUser;
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

interface GroupJoinRequest {
  id: string;
  groupId: string;
  requesterId: string;
  inviteCode: string;
  status: string;
  requestedAt: string;
  respondedAt: string | null;
  requester: GroupUser;
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

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
};

const mergeCategoryIntoTags = (tags: string[], category: string | null): string[] => {
  if (!category) {
    return tags;
  }

  return Array.from(new Set([...tags, category]));
};

export const normalizeInviteLinkVisibility = (value: unknown): InviteLinkVisibility => {
  return String(value || '').trim().toUpperCase() === 'MEMBERS' ? 'MEMBERS' : 'ADMINS';
};

export const generateGroupInviteCode = (): string => {
  return `grp_${randomBytes(18).toString('base64url')}`;
};

export const buildGroupInviteUrl = (inviteCode: string): string => {
  return `${GROUP_INVITE_BASE_URL}/groups/invite/${encodeURIComponent(inviteCode)}`;
};

export const canShareGroupInviteLink = (
  group: { creatorId?: string | null; inviteLinkVisibility?: string | null },
  membership: { role?: string | null } | null | undefined,
  userId: string
): boolean => {
  if (hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
    return true;
  }

  return normalizeInviteLinkVisibility(group.inviteLinkVisibility) === 'MEMBERS'
    && hasGroupRoleAtLeast(group, membership, userId, 'member');
};

const inviteExpiresAt = (): Date => new Date(Date.now() + GROUP_INVITE_EXPIRES_MS);

const normalizeInviteAction = (value: unknown): GroupInviteAction | null => {
  const action = String(value || '').trim().toLowerCase();
  return action === 'accept' || action === 'decline' ? action : null;
};

const selectGroupUser = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
};

const mapUser = (user: any): GroupUser => ({
  id: user.id,
  name: user.name,
  username: user.username,
  profileImage: user.profileImage,
  headline: user.headline ?? null,
  verified: Boolean(user.isVerified),
  isVerified: Boolean(user.isVerified),
  profileBadgeStyle: user.profileBadgeStyle ?? null,
});

const mapInviteGroup = (group: any) => ({
  id: group.id,
  name: group.name,
  slug: generateSlug(group.name),
  iconImage: group.iconImage ?? group.imageUrl ?? null,
  privacy: mapGroupPrivacy(group.isPrivate),
  memberCount: group.memberCount,
});

const mapGroupInvite = (invite: any): GroupInvite => ({
  id: invite.id,
  groupId: invite.groupId,
  invitedUserId: invite.invitedUserId,
  invitedById: invite.invitedById,
  status: invite.status,
  message: invite.message,
  createdAt: invite.createdAt.toISOString(),
  expiresAt: invite.expiresAt.toISOString(),
  respondedAt: invite.respondedAt ? invite.respondedAt.toISOString() : null,
  invitedUser: invite.invitedUser ? mapUser(invite.invitedUser) : undefined,
  invitedBy: mapUser(invite.invitedBy),
  group: mapInviteGroup(invite.groups),
});

const mapGroupJoinRequest = (request: any): GroupJoinRequest => ({
  id: request.id,
  groupId: request.groupId,
  requesterId: request.requesterId,
  inviteCode: request.inviteCode,
  status: request.status,
  requestedAt: request.requestedAt.toISOString(),
  respondedAt: request.respondedAt ? request.respondedAt.toISOString() : null,
  requester: mapUser(request.requester),
});

const buildInviteLinkResponse = (
  group: any,
  userId?: string | null,
  membership?: { role?: string | null } | null
) => {
  const memberRole = userId ? getEffectiveGroupRole(group, membership, userId) : null;
  const isMember = Boolean(membership) || memberRole === 'owner';
  const inviteCode = group.inviteCode || '';

  return {
    inviteCode,
    inviteUrl: inviteCode ? buildGroupInviteUrl(inviteCode) : null,
    visibility: normalizeInviteLinkVisibility(group.inviteLinkVisibility),
    canShare: Boolean(userId && canShareGroupInviteLink(group, membership, userId)),
    requiresApproval: Boolean(group.isPrivate),
    group: {
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
      memberCount: group._count?.group_members ?? group.memberCount,
      postCount: 0,
      createdAt: group.createdAt?.toISOString?.() ?? new Date().toISOString(),
      isMember,
      memberRole: memberRole ? mapRoleToEnum(memberRole) : null,
      ...(userId ? { isAddedToMessages: Boolean((membership as any)?.showInMessages) } : {}),
    },
  };
};

export const mapRoleToEnum = (role: string): GroupMemberRole => {
  const roleMap: { [key: string]: GroupMemberRole } = {
    admin: 'ADMIN',
    moderator: 'MODERATOR',
    member: 'MEMBER',
    owner: 'OWNER',
  };
  return roleMap[role.toLowerCase()] || 'MEMBER';
};

export const GROUP_ROLE_RANK: Record<string, number> = {
  member: 1,
  moderator: 2,
  admin: 3,
  owner: 4,
};

export const normalizeGroupRole = (role: unknown): string | null => {
  if (typeof role !== 'string') {
    return null;
  }

  const normalized = role.trim().toLowerCase();
  return GROUP_ROLE_RANK[normalized] ? normalized : null;
};

export const getEffectiveGroupRole = (
  group: { creatorId?: string | null },
  membership: { role?: string | null } | null | undefined,
  userId: string
): string | null => {
  if (group.creatorId === userId) {
    return 'owner';
  }

  return normalizeGroupRole(membership?.role);
};

export const hasGroupRoleAtLeast = (
  group: { creatorId?: string | null },
  membership: { role?: string | null } | null | undefined,
  userId: string,
  minimumRole: keyof typeof GROUP_ROLE_RANK
): boolean => {
  const role = getEffectiveGroupRole(group, membership, userId);
  return Boolean(role && GROUP_ROLE_RANK[role] >= GROUP_ROLE_RANK[minimumRole]);
};

const buildGroupMessagePreview = (content: string, contentType: string): string => {
  if (content && content.trim()) {
    return content.trim();
  }

  switch (contentType) {
    case 'image':
      return 'Sent a photo';
    case 'video':
      return 'Sent a video';
    case 'file':
      return 'Sent a file';
    case 'audio':
      return 'Sent a voice message';
    default:
      return 'Sent a message';
  }
};

const groupShortcutInclude = {
  groups: {
    include: {
      _count: { select: { group_members: true } },
      group_messages: {
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        include: {
          users: { select: selectGroupUser },
        },
      },
    },
  },
};

const mapGroupMessageShortcut = (membership: any): GroupMessageShortcut => {
  const group = membership.groups;
  const latestMessage = Array.isArray(group.group_messages) ? group.group_messages[0] : null;
  const addedAtDate = membership.messagesAddedAt ?? membership.joinedAt ?? group.createdAt ?? new Date();
  const lastActivityDate = latestMessage?.createdAt ?? membership.messagesAddedAt ?? membership.joinedAt ?? group.updatedAt ?? addedAtDate;
  const sender = latestMessage?.users ? mapUser(latestMessage.users) : null;

  return {
    id: group.id,
    groupId: group.id,
    name: group.name,
    slug: generateSlug(group.name),
    description: group.description,
    coverImage: group.coverImage ?? group.imageUrl,
    iconImage: group.iconImage ?? group.imageUrl,
    privacy: mapGroupPrivacy(group.isPrivate),
    memberCount: group._count?.group_members ?? group.memberCount ?? 0,
    memberRole: mapRoleToEnum(getEffectiveGroupRole(group, membership, membership.userId) || membership.role),
    addedAt: addedAtDate.toISOString(),
    lastActivityAt: lastActivityDate.toISOString(),
    latestMessage: latestMessage ? {
      id: latestMessage.id,
      content: latestMessage.content,
      contentType: latestMessage.contentType,
      preview: buildGroupMessagePreview(latestMessage.content, latestMessage.contentType),
      senderId: latestMessage.senderId,
      senderName: sender?.name || sender?.username || 'Someone',
      createdAt: latestMessage.createdAt.toISOString(),
    } : null,
    isAddedToMessages: true,
  };
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

/**
 * List the current user's personal group shortcuts in Messages.
 * GET /api/groups/message-shortcuts
 */
export const getGroupMessageShortcuts = async (
  req: AuthenticatedRequest,
  res: Response<{ shortcuts: GroupMessageShortcut[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const memberships = await prisma.group_members.findMany({
      where: {
        userId,
        showInMessages: true,
      },
      include: groupShortcutInclude,
      orderBy: [
        { messagesAddedAt: 'desc' },
        { joinedAt: 'desc' },
      ],
    });

    const shortcuts = memberships
      .map(mapGroupMessageShortcut)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));

    res.status(200).json({ shortcuts });
  } catch (error) {
    console.error('Error fetching group message shortcuts:', error);
    res.status(500).json({ error: 'Failed to fetch group message shortcuts' });
  }
};

/**
 * Toggle the current user's personal group shortcut in Messages.
 * PATCH /api/groups/:groupId/message-shortcut
 */
export const updateGroupMessageShortcut = async (
  req: AuthenticatedRequest,
  res: Response<{ groupId: string; enabled: boolean; shortcut: GroupMessageShortcut | null } | ErrorResponse>
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
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    const enabled = req.body.enabled;
    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

    const updatedMembership = await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: {
        showInMessages: enabled,
        messagesAddedAt: enabled ? (membership.messagesAddedAt ?? new Date()) : null,
      },
      include: groupShortcutInclude,
    });

    res.status(200).json({
      groupId,
      enabled,
      shortcut: enabled ? mapGroupMessageShortcut(updatedMembership) : null,
    });
  } catch (error) {
    console.error('Error updating group message shortcut:', error);
    res.status(500).json({ error: 'Failed to update group message shortcut' });
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

    const userId = String(req.user.userId);
    const blockedUserIds = await getBlockedUserIds(userId);
    await prisma.group_invites.updateMany({
      where: {
        invitedUserId: userId,
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired', respondedAt: new Date() },
    });

    const invites = await prisma.group_invites.findMany({
      where: {
        invitedUserId: userId,
        ...(blockedUserIds.length > 0 ? { invitedById: { notIn: blockedUserIds } } : {}),
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        groups: true,
        invitedBy: { select: selectGroupUser },
        invitedUser: { select: selectGroupUser },
      },
    });

    res.status(200).json({ invites: invites.map(mapGroupInvite) });
  } catch (error) {
    console.error('Error fetching pending invites:', error);
    res.status(500).json({ error: 'Failed to fetch pending invites' });
  }
};

/**
 * Preview a group invite link
 * GET /api/groups/invites/link/:code
 */
export const getGroupInviteLinkPreview = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    const inviteCode = ensureString(req.params.code);
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const userId = req.user?.userId ? String(req.user.userId) : null;
    const group = await prisma.groups.findUnique({
      where: { inviteCode },
      include: {
        group_members: userId ? { where: { userId } } : false,
        _count: { select: { group_members: true } },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Invite link is invalid or has been reset' });
      return;
    }

    const groupWithMembership = group as typeof group & { group_members?: Array<{ role: string }> };
    const membership = Array.isArray(groupWithMembership.group_members) ? groupWithMembership.group_members[0] : null;

    res.status(200).json(buildInviteLinkResponse(group, userId, membership));
  } catch (error) {
    console.error('Error previewing group invite link:', error);
    res.status(500).json({ error: 'Failed to preview invite link' });
  }
};

/**
 * Join a group from an invite link
 * POST /api/groups/invites/link/:code/join
 */
export const joinGroupByInviteLink = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string; groupId: string; requestId?: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const inviteCode = ensureString(req.params.code);
    if (!inviteCode) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const group = await prisma.groups.findUnique({
      where: { inviteCode },
      include: { group_members: { where: { userId } } },
    });

    if (!group) {
      res.status(404).json({ error: 'Invite link is invalid or has been reset' });
      return;
    }

    const groupWithMembers = group as typeof group & { group_members: unknown[] };
    if (groupWithMembers.group_members.length > 0 || group.creatorId === userId) {
      res.status(200).json({
        status: 'already_member',
        message: 'You are already a member of this group',
        groupId: group.id,
      });
      return;
    }

    if (group.memberCount >= group.maxMembers) {
      res.status(400).json({ error: 'Group is full' });
      return;
    }

    if (group.isPrivate) {
      const request = await prisma.group_join_requests.upsert({
        where: { groupId_requesterId: { groupId: group.id, requesterId: userId } },
        update: {
          inviteCode,
          status: 'pending',
          requestedAt: new Date(),
          reviewedById: null,
          respondedAt: null,
        },
        create: {
          id: randomUUID(),
          groupId: group.id,
          requesterId: userId,
          inviteCode,
          status: 'pending',
        },
      });

      res.status(202).json({
        status: 'pending',
        message: 'Your request to join this group is waiting for admin approval',
        groupId: group.id,
        requestId: request.id,
      });
      return;
    }

    await prisma.$transaction([
      prisma.group_members.create({
        data: {
          id: randomUUID(),
          groupId: group.id,
          userId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: group.id },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({
      status: 'joined',
      message: 'Successfully joined the group',
      groupId: group.id,
    });
  } catch (error) {
    console.error('Error joining group by invite link:', error);
    res.status(500).json({ error: 'Failed to join group from invite link' });
  }
};

/**
 * Get a group's invite link
 * GET /api/groups/:groupId/invite-link
 */
export const getGroupInviteLink = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
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

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({
        where: { id: groupId },
        include: { _count: { select: { group_members: true } } },
      }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!canShareGroupInviteLink(group, membership, userId)) {
      res.status(403).json({ error: 'Not authorized to view this group invite link' });
      return;
    }

    res.status(200).json(buildInviteLinkResponse(group, userId, membership));
  } catch (error) {
    console.error('Error fetching group invite link:', error);
    res.status(500).json({ error: 'Failed to fetch invite link' });
  }
};

/**
 * Update invite link sharing settings
 * PATCH /api/groups/:groupId/invite-link/settings
 */
export const updateGroupInviteLinkSettings = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
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

    const visibility = normalizeInviteLinkVisibility(req.body?.visibility);
    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true, inviteLinkVisibility: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to update invite link settings' });
      return;
    }

    const updateData: any = {
      inviteLinkVisibility: visibility,
      inviteLinkUpdatedAt: new Date(),
      updatedAt: new Date(),
    };
    if (visibility === 'ADMINS' && normalizeInviteLinkVisibility(group.inviteLinkVisibility) === 'MEMBERS') {
      updateData.inviteCode = generateGroupInviteCode();
    }

    const updatedGroup = await prisma.groups.update({
      where: { id: groupId },
      data: updateData,
      include: { _count: { select: { group_members: true } } },
    });

    res.status(200).json(buildInviteLinkResponse(updatedGroup, userId, membership));
  } catch (error) {
    console.error('Error updating group invite link settings:', error);
    res.status(500).json({ error: 'Failed to update invite link settings' });
  }
};

/**
 * Reset a group's invite link
 * POST /api/groups/:groupId/invite-link/reset
 */
export const resetGroupInviteLink = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
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

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to reset this invite link' });
      return;
    }

    const updatedGroup = await prisma.groups.update({
      where: { id: groupId },
      data: {
        inviteCode: generateGroupInviteCode(),
        inviteLinkUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
      include: { _count: { select: { group_members: true } } },
    });

    res.status(200).json(buildInviteLinkResponse(updatedGroup, userId, membership));
  } catch (error) {
    console.error('Error resetting group invite link:', error);
    res.status(500).json({ error: 'Failed to reset invite link' });
  }
};

/**
 * Invite a user directly to a group
 * POST /api/groups/:groupId/invites
 */
export const createGroupInvite = async (
  req: AuthenticatedRequest,
  res: Response<{ invite: GroupInvite } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const invitedById = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const invitedUserId = ensureString(req.body?.userId) || ensureString(req.body?.invitedUserId);
    const message = normalizeOptionalString(req.body?.message);
    if (!groupId || !invitedUserId) {
      res.status(400).json({ error: 'Group ID and invited user ID are required' });
      return;
    }
    if (invitedById === invitedUserId) {
      res.status(400).json({ error: 'You cannot invite yourself' });
      return;
    }
    await assertUsersCanInteract(invitedById, invitedUserId, 'group invitation');

    const [group, inviterMembership, invitedUser, existingMembership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, name: true, creatorId: true, memberCount: true, maxMembers: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId: invitedById } } }),
      prisma.user.findFirst({ where: { id: invitedUserId, isBanned: false }, select: selectGroupUser }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId: invitedUserId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, inviterMembership, invitedById, 'admin')) {
      res.status(403).json({ error: 'Not authorized to invite users to this group' });
      return;
    }
    if (!invitedUser) {
      res.status(404).json({ error: 'Invited user not found' });
      return;
    }
    if (existingMembership) {
      res.status(400).json({ error: 'User is already a member of this group' });
      return;
    }
    if (group.memberCount >= group.maxMembers) {
      res.status(400).json({ error: 'Group is full' });
      return;
    }

    const invite = await prisma.group_invites.upsert({
      where: { groupId_invitedUserId: { groupId, invitedUserId } },
      update: {
        invitedById,
        status: 'pending',
        message,
        createdAt: new Date(),
        expiresAt: inviteExpiresAt(),
        respondedAt: null,
      },
      create: {
        id: randomUUID(),
        groupId,
        invitedUserId,
        invitedById,
        status: 'pending',
        message,
        expiresAt: inviteExpiresAt(),
      },
      include: {
        groups: true,
        invitedBy: { select: selectGroupUser },
        invitedUser: { select: selectGroupUser },
      },
    });

    if (!(await areUsersBlocked(invitedById, invitedUserId))) {
      pushNotificationService.pushStudyGroupInvite(invitedUserId, group.name, 'Someone', groupId).catch(() => undefined);
    }

    res.status(201).json({ invite: mapGroupInvite(invite) });
  } catch (error) {
    const safety = safetyErrorResponse(error);
    if (safety) {
      res.status(safety.statusCode).json(safety.body);
      return;
    }
    console.error('Error creating group invite:', error);
    res.status(500).json({ error: 'Failed to create group invite' });
  }
};

/**
 * Respond to a direct group invite
 * POST /api/groups/invites/:inviteId/respond
 */
export const respondToGroupInvite = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string; groupId: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const inviteId = ensureString(req.params.inviteId);
    const action = normalizeInviteAction(req.body?.action);
    if (!inviteId || !action) {
      res.status(400).json({ error: 'Invite ID and action are required' });
      return;
    }

    const invite = await prisma.group_invites.findUnique({
      where: { id: inviteId },
      include: { groups: { include: { group_members: { where: { userId } } } } },
    });

    if (!invite || invite.invitedUserId !== userId) {
      res.status(404).json({ error: 'Group invite not found' });
      return;
    }
    if (await areUsersBlocked(userId, invite.invitedById)) {
      res.status(404).json({ error: 'This resource is unavailable.', code: 'resource_unavailable', retryable: false } as any);
      return;
    }
    if (invite.status !== 'pending') {
      res.status(400).json({ error: 'This invite has already been handled' });
      return;
    }
    if (invite.expiresAt < new Date()) {
      await prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'expired', respondedAt: new Date() },
      });
      res.status(400).json({ error: 'This invite has expired' });
      return;
    }

    if (action === 'decline') {
      await prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'declined', respondedAt: new Date() },
      });
      res.status(200).json({ status: 'declined', message: 'Invite declined', groupId: invite.groupId });
      return;
    }

    const group = invite.groups as typeof invite.groups & { group_members: unknown[] };
    if (group.group_members.length > 0 || group.creatorId === userId) {
      await prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      res.status(200).json({ status: 'already_member', message: 'You are already a member of this group', groupId: invite.groupId });
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
          groupId: invite.groupId,
          userId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: invite.groupId },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
      prisma.group_invites.update({
        where: { id: inviteId },
        data: { status: 'accepted', respondedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({ status: 'joined', message: 'Successfully joined the group', groupId: invite.groupId });
  } catch (error) {
    console.error('Error responding to group invite:', error);
    res.status(500).json({ error: 'Failed to respond to group invite' });
  }
};

/**
 * Get pending join requests for a private/secret group
 * GET /api/groups/:groupId/join-requests
 */
export const getGroupJoinRequests = async (
  req: AuthenticatedRequest,
  res: Response<{ requests: GroupJoinRequest[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const status = ensureString(req.query.status) || 'pending';
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId } } }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to view join requests' });
      return;
    }

    const requests = await prisma.group_join_requests.findMany({
      where: { groupId, status: status.toLowerCase() },
      orderBy: { requestedAt: 'desc' },
      include: { requester: { select: selectGroupUser } },
    });

    res.status(200).json({ requests: requests.map(mapGroupJoinRequest) });
  } catch (error) {
    console.error('Error fetching group join requests:', error);
    res.status(500).json({ error: 'Failed to fetch join requests' });
  }
};

/**
 * Respond to a private/secret group join request
 * POST /api/groups/:groupId/join-requests/:requestId/respond
 */
export const respondToGroupJoinRequest = async (
  req: AuthenticatedRequest,
  res: Response<{ status: string; message: string; groupId: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const reviewedById = String(req.user.userId);
    const groupId = ensureString(req.params.groupId);
    const requestId = ensureString(req.params.requestId);
    const action = normalizeInviteAction(req.body?.action);
    if (!groupId || !requestId || !action) {
      res.status(400).json({ error: 'Group ID, request ID, and action are required' });
      return;
    }

    const [group, reviewerMembership, joinRequest] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true, memberCount: true, maxMembers: true } }),
      prisma.group_members.findUnique({ where: { groupId_userId: { groupId, userId: reviewedById } } }),
      prisma.group_join_requests.findUnique({ where: { id: requestId } }),
    ]);

    if (!group || !joinRequest || joinRequest.groupId !== groupId) {
      res.status(404).json({ error: 'Join request not found' });
      return;
    }
    if (!hasGroupRoleAtLeast(group, reviewerMembership, reviewedById, 'admin')) {
      res.status(403).json({ error: 'Not authorized to manage join requests' });
      return;
    }
    if (joinRequest.status !== 'pending') {
      res.status(400).json({ error: 'This join request has already been handled' });
      return;
    }

    if (action === 'decline') {
      await prisma.group_join_requests.update({
        where: { id: requestId },
        data: { status: 'declined', reviewedById, respondedAt: new Date() },
      });
      res.status(200).json({ status: 'declined', message: 'Join request declined', groupId });
      return;
    }

    const existingMembership = await prisma.group_members.findUnique({
      where: { groupId_userId: { groupId, userId: joinRequest.requesterId } },
    });
    if (existingMembership || group.creatorId === joinRequest.requesterId) {
      await prisma.group_join_requests.update({
        where: { id: requestId },
        data: { status: 'accepted', reviewedById, respondedAt: new Date() },
      });
      res.status(200).json({ status: 'already_member', message: 'Requester is already a member', groupId });
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
          userId: joinRequest.requesterId,
          role: 'member',
        },
      }),
      prisma.groups.update({
        where: { id: groupId },
        data: { memberCount: { increment: 1 }, updatedAt: new Date() },
      }),
      prisma.group_join_requests.update({
        where: { id: requestId },
        data: { status: 'accepted', reviewedById, respondedAt: new Date() },
      }),
    ]);

    invalidateGroupListCache();
    res.status(200).json({ status: 'joined', message: 'Join request approved', groupId });
  } catch (error) {
    console.error('Error responding to group join request:', error);
    res.status(500).json({ error: 'Failed to respond to join request' });
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

    if (group.isPrivate) {
      res.status(403).json({ error: 'Private groups require an invitation' });
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

    invalidateGroupListCache();
    res.status(200).json({
      status: 'joined',
      message: 'Successfully joined the group',
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

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group || !membership) {
      res.status(400).json({ error: 'Not a member of this group' });
      return;
    }
    if (group.creatorId === userId) {
      res.status(400).json({ error: 'Transfer ownership or delete the group before leaving' });
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

    invalidateGroupListCache();
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
    const currentUserId = req.user?.userId ? String(req.user.userId) : null;

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, isPrivate: true, creatorId: true },
    });
    if (!group || !(await canViewGroup(group, currentUserId))) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

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
      select: { id: true, name: true, username: true, profileImage: true, headline: true, isVerified: true, profileBadgeStyle: true },
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
 * Get group posts
 * GET /api/groups/:groupId/posts
 */
export const getGroupPosts = async (
  req: AuthenticatedRequest,
  res: Response<any | ErrorResponse>
): Promise<void> => {
  try {
    const currentUserId = req.user?.userId ? String(req.user.userId) : null;
    const groupId = ensureString(req.params.groupId);
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const pinnedFirst = req.query.pinnedFirst === 'true';

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: { id: true, isPrivate: true, creatorId: true },
    });
    if (!group || !(await canViewGroup(group, currentUserId))) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

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

    const groupId = ensureString(req.params.groupId);
    const { content, mediaUrls, mediaType } = req.body;
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId: String(req.user.userId) } },
      }),
    ]);

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this group' });
      return;
    }

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

    const [groupRecord, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!groupRecord) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    if (!hasGroupRoleAtLeast(groupRecord, membership, userId, 'admin')) {
      res.status(403).json({ error: 'Not authorized to update this group' });
      return;
    }

    const updateData: any = {};
    if (name) updateData.name = name.trim();
    if (description !== undefined) updateData.description = normalizeOptionalString(description);
    if (privacy) updateData.isPrivate = privacy === 'PRIVATE' || privacy === 'SECRET';
    if (category !== undefined) updateData.category = normalizeOptionalString(category);
    if (rules !== undefined) updateData.rules = normalizeStringList(rules);
    if (tags) updateData.tags = mergeCategoryIntoTags(normalizeStringList(tags), updateData.category ?? null);
    if (coverImage) updateData.coverImage = coverImage;
    if (iconImage) updateData.iconImage = iconImage;

    const updateDataWithTimestamp = { ...updateData, updatedAt: new Date() };
    const group = await prisma.groups.update({
      where: { id: groupId },
      data: updateDataWithTimestamp,
    });

    invalidateGroupListCache();
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
      isMember: true,
      memberRole: mapRoleToEnum(getEffectiveGroupRole(groupRecord, membership, userId) || 'member'),
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

    invalidateGroupListCache();
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

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: rawGroupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId: rawGroupId, userId } },
      }),
    ]);
    if (!group || !hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
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

    invalidateGroupListCache();
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

    const [group, membership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: rawGroupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId: rawGroupId, userId } },
      }),
    ]);
    if (!group || !hasGroupRoleAtLeast(group, membership, userId, 'admin')) {
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

    invalidateGroupListCache();
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
    const targetRole = normalizeGroupRole(role);
    if (!targetRole || targetRole === 'owner') {
      res.status(400).json({ error: 'Role must be member, moderator, or admin' });
      return;
    }

    if (currentUserId === userId) {
      res.status(400).json({ error: 'Use group ownership transfer or leave flow for your own role' });
      return;
    }

    const [group, currentMembership, targetMembership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId: currentUserId } },
      }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group || !targetMembership) {
      res.status(404).json({ error: 'Group member not found' });
      return;
    }
    if (group.creatorId === userId) {
      res.status(403).json({ error: 'The group owner role cannot be changed' });
      return;
    }

    const currentRole = getEffectiveGroupRole(group, currentMembership, currentUserId);
    const targetCurrentRole = getEffectiveGroupRole(group, targetMembership, userId);
    const currentRank = currentRole ? GROUP_ROLE_RANK[currentRole] : 0;
    const targetCurrentRank = targetCurrentRole ? GROUP_ROLE_RANK[targetCurrentRole] : 0;
    const targetRank = GROUP_ROLE_RANK[targetRole];

    if (currentRank < GROUP_ROLE_RANK.admin || currentRank <= targetCurrentRank || currentRank <= targetRank) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    await prisma.group_members.update({
      where: { groupId_userId: { groupId, userId } },
      data: { role: targetRole },
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

    if (currentUserId === userId) {
      res.status(400).json({ error: 'Use the leave group endpoint to remove yourself' });
      return;
    }

    const [group, currentMembership, targetMembership] = await Promise.all([
      prisma.groups.findUnique({ where: { id: groupId }, select: { id: true, creatorId: true } }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId: currentUserId } },
      }),
      prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      }),
    ]);

    if (!group || !targetMembership) {
      res.status(404).json({ error: 'Group member not found' });
      return;
    }
    if (group.creatorId === userId) {
      res.status(403).json({ error: 'The group owner cannot be removed' });
      return;
    }

    const currentRole = getEffectiveGroupRole(group, currentMembership, currentUserId);
    const targetRole = getEffectiveGroupRole(group, targetMembership, userId);
    const currentRank = currentRole ? GROUP_ROLE_RANK[currentRole] : 0;
    const targetRank = targetRole ? GROUP_ROLE_RANK[targetRole] : 0;

    if (currentRank < GROUP_ROLE_RANK.moderator || currentRank <= targetRank) {
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

    invalidateGroupListCache();
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
            isVerified: true,
            profileBadgeStyle: true,
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

    const groupId = ensureString(req.params.groupId);
    const { content, contentType, mediaUrl, mediaType, fileName, fileSize, replyToId } = req.body;
    if (!groupId) {
      res.status(400).json({ error: 'Group ID is required' });
      return;
    }

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

    const group = await prisma.groups.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        iconImage: true,
        imageUrl: true,
        coverImage: true,
        group_members: {
          where: {
            userId: { not: String(req.user.userId) },
          },
          select: { userId: true },
        },
      },
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const replyMessageId = replyToId != null ? ensureString(replyToId) : null;
    if (replyMessageId) {
      const replyMessage = await prisma.group_messages.findFirst({
        where: { id: replyMessageId, groupId, isDeleted: false },
        select: { id: true },
      });
      if (!replyMessage) {
        res.status(400).json({ error: 'Reply target is not in this group' });
        return;
      }
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
        replyToId: replyMessageId || undefined,
        updatedAt: new Date(),
      },
      include: {
        users: {
          select: {
            id: true,
            username: true,
            name: true,
            profileImage: true,
            isVerified: true,
            profileBadgeStyle: true,
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
    const messagePayload = {
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
    };

    const sender = msg.users as { name?: string | null; username?: string | null; profileImage?: string | null } | null;
    const senderName = sender?.name || sender?.username || 'Someone';
    const groupImage = group.iconImage || group.imageUrl || group.coverImage || undefined;
    const preview = buildGroupMessagePreview(message.content, message.contentType);
    const recipientIds = group.group_members.map((member) => member.userId);

    getIO()?.to(`group:${groupId}`).emit('group:new_message', {
      ...messagePayload,
      groupName: group.name,
      groupImage: groupImage || '',
    });

    if (recipientIds.length > 0) {
      pushNotificationService.pushGroupMessageToUsers(
        recipientIds,
        group.name,
        senderName,
        preview,
        groupId,
        String(req.user.userId),
        groupImage,
        sender?.profileImage || undefined
      ).catch(console.error);
    }

    res.status(201).json(messagePayload);
  } catch (error) {
    console.error('Error sending group message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
};
