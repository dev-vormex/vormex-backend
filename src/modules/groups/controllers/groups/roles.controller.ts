import { GroupMemberRole } from "./support.controller";

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
