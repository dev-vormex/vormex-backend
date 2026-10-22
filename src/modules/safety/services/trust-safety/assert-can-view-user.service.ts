import { prisma } from "../../../../config/prisma";
import { discoverableUsersWhere, evaluateNotificationRecipient, evaluateProfileVisibility } from "../safety-policy";
import { findBlockBetween, areUsersBlocked, getBlockedUserIds } from "./create-user-block-with-device-scope.service";
import { SafetyActionError } from "./safety-action-error.service";

/**
 * May the viewer see the target user's profile/content? Throws the standard
 * 404 resource_unavailable (identical for block and unavailable target so a
 * block is not detectable). Viewer === target is always allowed.
 */
export async function assertCanViewUser(viewerId: string, targetUserId: string): Promise<void> {
  if (!viewerId || !targetUserId || viewerId === targetUserId) return;
  const [target, block] = await Promise.all([
    prisma.user.findUnique({
      where: { id: targetUserId },
      select: { isBanned: true, safetySuspendedUntil: true },
    }),
    findBlockBetween(viewerId, targetUserId),
  ]);
  const decision = evaluateProfileVisibility({
    viewerId,
    targetId: targetUserId,
    target,
    blocked: Boolean(block),
  });
  if (!decision.allowed) throw new SafetyActionError('This resource is unavailable.', 'resource_unavailable', 404, undefined, false);
}

/**
 * Should `recipientId` be notified (in-app or push) about `actorId`'s action?
 * Mirrors the suppression in NotificationService.createNotification so push
 * paths can use the same rule.
 */
export async function shouldNotifyUser(actorId: string | null | undefined, recipientId: string): Promise<boolean> {
  if (!actorId) return true;
  const blocked = await areUsersBlocked(actorId, recipientId);
  return evaluateNotificationRecipient({ actorId, recipientId, blocked }).allowed;
}

/**
 * Prisma where fragment for users that may appear in discovery for the viewer
 * (not self, banned, currently suspended, or blocked in either direction).
 */
export async function getDiscoverableUsersWhere(viewerId: string) {
  return discoverableUsersWhere(viewerId, await getBlockedUserIds(viewerId));
}
