import { prisma } from '../../../config/prisma';
import { httpError } from '../../../shared/utils/http-error.util';
import { requireGroupAccess, groupAuthorSelect } from './group-access.service';

export async function listGroupInvites(groupId: string, userId: string, status: string) {
  const access = await requireGroupAccess(groupId, userId);
  if (!access.canManageInvites) throw httpError(403, 'Only group admins can view invitations');
  const normalized = status.toLowerCase();
  if (!['pending', 'accepted', 'declined', 'expired', 'cancelled'].includes(normalized))
    throw httpError(400, 'Invalid invitation status');
  const invites = await prisma.group_invites.findMany({
    where: { groupId, status: normalized },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 500,
    include: { invitedUser: { select: groupAuthorSelect }, invitedBy: { select: groupAuthorSelect } },
  });
  return { invites: invites.map((invite) => ({ ...invite, status: invite.status.toUpperCase() })) };
}

export async function cancelGroupInvite(groupId: string, inviteId: string, userId: string) {
  const access = await requireGroupAccess(groupId, userId);
  if (!access.canManageInvites) throw httpError(403, 'Only group admins can cancel invitations');
  const changed = await prisma.group_invites.updateMany({
    where: { id: inviteId, groupId, status: 'pending' },
    data: { status: 'cancelled', respondedAt: new Date() },
  });
  if (!changed.count) throw httpError(404, 'Pending invitation not found');
  return { success: true };
}

export async function reactToGroupMessage(groupId: string, messageId: string, userId: string, emoji: unknown) {
  await requireGroupAccess(groupId, userId);
  if (typeof emoji !== 'string' || emoji.trim().length === 0 || emoji.length > 32)
    throw httpError(400, 'Invalid reaction');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM group_messages WHERE id = ${messageId} AND "groupId" = ${groupId} FOR UPDATE`;
    const message = await tx.group_messages.findFirst({ where: { id: messageId, groupId, isDeleted: false } });
    if (!message) throw httpError(404, 'Message not found');
    const existing = await tx.group_message_reactions.findFirst({ where: { messageId, userId } });
    if (existing?.emoji === emoji) {
      await tx.group_message_reactions.delete({ where: { id: existing.id } });
      return { action: 'removed' as const };
    }
    if (existing) {
      await tx.group_message_reactions.update({ where: { id: existing.id }, data: { emoji } });
      return { action: 'updated' as const };
    }
    await tx.group_message_reactions.create({ data: { messageId, userId, emoji } });
    return { action: 'added' as const };
  });
}

export async function deleteGroupMessageRecord(groupId: string, messageId: string, userId: string) {
  const access = await requireGroupAccess(groupId, userId);
  const message = await prisma.group_messages.findFirst({ where: { id: messageId, groupId, isDeleted: false } });
  if (!message) throw httpError(404, 'Message not found');
  if (message.senderId !== userId && !access.canModerate) throw httpError(403, 'Not allowed to delete this message');
  await prisma.group_messages.updateMany({
    where: { id: messageId, groupId },
    data: { isDeleted: true, content: '', mediaUrl: null, fileName: null, fileSize: null },
  });
  return { success: true };
}
