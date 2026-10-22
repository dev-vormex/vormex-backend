import { cacheService } from "../../../../infrastructure/cache/cache.service";

export type GroupPrivacy = 'PUBLIC' | 'PRIVATE' | 'SECRET';

export type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';

export const GROUP_LIST_CACHE_TAG = 'groups:list';

export const GROUP_LIST_CACHE_SOFT_TTL_SECONDS = 30;

export const GROUP_LIST_CACHE_HARD_TTL_SECONDS = 120;

export interface GroupUser {
  id: string;
  name: string;
  username: string;
  profileImage: string | null;
  headline?: string | null;
  verified?: boolean;
  isVerified?: boolean;
  profileBadgeStyle?: string | null;
}

export interface Group {
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

export interface GroupShortcutLatestMessage {
  id: string;
  content: string;
  contentType: string;
  preview: string;
  senderId: string;
  senderName: string;
  createdAt: string;
}

export interface GroupMessageShortcut {
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

export interface GroupsResponse {
  groups: Group[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const normalizeGroupListQueryValue = (value: unknown, maxLength = 80): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

export function invalidateGroupListCache(): void {
  void cacheService.invalidateTags(GROUP_LIST_CACHE_TAG).catch((error: unknown) => {
    console.error('Failed to invalidate group list cache:', error);
  });
}

export interface GroupJoinRequest {
  id: string;
  groupId: string;
  requesterId: string;
  inviteCode: string;
  status: string;
  requestedAt: string;
  respondedAt: string | null;
  requester: GroupUser;
}

export const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
};

export const mapGroupPrivacy = (isPrivate: boolean): GroupPrivacy => {
  return isPrivate ? 'PRIVATE' : 'PUBLIC';
};

export const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const normalizeStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
};

export const mergeCategoryIntoTags = (tags: string[], category: string | null): string[] => {
  if (!category) {
    return tags;
  }

  return Array.from(new Set([...tags, category]));
};

export const selectGroupUser = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
};

export const mapUser = (user: any): GroupUser => ({
  id: user.id,
  name: user.name,
  username: user.username,
  profileImage: user.profileImage,
  headline: user.headline ?? null,
  verified: Boolean(user.isVerified),
  isVerified: Boolean(user.isVerified),
  profileBadgeStyle: user.profileBadgeStyle ?? null,
});

export const mapGroupJoinRequest = (request: any): GroupJoinRequest => ({
  id: request.id,
  groupId: request.groupId,
  requesterId: request.requesterId,
  inviteCode: request.inviteCode,
  status: request.status,
  requestedAt: request.requestedAt.toISOString(),
  respondedAt: request.respondedAt ? request.respondedAt.toISOString() : null,
  requester: mapUser(request.requester),
});
