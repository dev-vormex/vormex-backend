import { prisma } from '../../../config/prisma';
import { httpError } from '../../../shared/utils/http-error.util';

export const groupAuthorSelect = {
  id: true,
  name: true,
  username: true,
  profileImage: true,
  headline: true,
  isVerified: true,
  profileBadgeStyle: true,
} as const;

export async function requireGroupAccess(groupId: string, userId: string | null, write = true) {
  const group = await prisma.groups.findUnique({ where: { id: groupId } });
  if (!group) throw httpError(404, 'Group not found');
  const membership = userId
    ? await prisma.group_members.findUnique({
        where: { groupId_userId: { groupId, userId } },
      })
    : null;
  const owner = userId !== null && group.creatorId === userId;
  if (group.isPrivate && !membership && !owner) throw httpError(404, 'Group not found');
  if (write && !membership && !owner) throw httpError(403, 'Join this group first');
  const role = owner ? 'owner' : membership?.role.toLowerCase();
  return {
    group,
    membership,
    canModerate: ['owner', 'admin', 'moderator'].includes(role ?? ''),
    canManageInvites: ['owner', 'admin'].includes(role ?? ''),
  };
}
