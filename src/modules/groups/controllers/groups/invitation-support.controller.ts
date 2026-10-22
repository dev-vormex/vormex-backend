import { randomBytes } from "crypto";
import { GroupUser, GroupPrivacy, generateSlug, mapGroupPrivacy, mapUser } from "./support.controller";
import { hasGroupRoleAtLeast, getEffectiveGroupRole, mapRoleToEnum } from "./roles.controller";

export type InviteLinkVisibility = 'ADMINS' | 'MEMBERS';

export type GroupInviteAction = 'accept' | 'decline';

export const GROUP_INVITE_EXPIRES_MS = 3 * 24 * 60 * 60 * 1000;

export const GROUP_INVITE_BASE_URL = (process.env.FRONTEND_URL || 'https://vormex.in').replace(/\/+$/, '');

export interface GroupInvite {
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

export const inviteExpiresAt = (): Date => new Date(Date.now() + GROUP_INVITE_EXPIRES_MS);

export const normalizeInviteAction = (value: unknown): GroupInviteAction | null => {
  const action = String(value || '').trim().toLowerCase();
  return action === 'accept' || action === 'decline' ? action : null;
};

export const mapInviteGroup = (group: any) => ({
  id: group.id,
  name: group.name,
  slug: generateSlug(group.name),
  iconImage: group.iconImage ?? group.imageUrl ?? null,
  privacy: mapGroupPrivacy(group.isPrivate),
  memberCount: group.memberCount,
});

export const mapGroupInvite = (invite: any): GroupInvite => ({
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

export const buildInviteLinkResponse = (
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
