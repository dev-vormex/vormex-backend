import { prisma } from "../../../../config/prisma";
import { isUUID } from "../../../../shared/utils/username.util";
import { areUsersBlocked } from "../../../safety/services/trust-safety.service";
import { Response } from "express";

export const PROFILE_BADGE_STYLES = new Set(['student', 'professional']);

export function normalizeProfileBadgeStyle(value: unknown): string | null {
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Profile badge style must be a string');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!PROFILE_BADGE_STYLES.has(normalized)) {
    throw new Error('Profile badge style is not supported');
  }
  return normalized;
}

export const uniqueCacheTags = (tags: string[]): string[] => Array.from(new Set(tags.filter(Boolean)));

export const resolveProfileTargetId = async (userIdOrUsername: string): Promise<string | null> => {
  const user = await prisma.user.findFirst({
    where: isUUID(userIdOrUsername)
      ? { id: userIdOrUsername }
      : { username: userIdOrUsername.toLowerCase() },
    select: { id: true },
  });
  return user?.id || null;
};

export const isProfileUnavailable = async (
  requestingUserId: string | null,
  userIdOrUsername: string
): Promise<boolean> => {
  if (!requestingUserId) return false;
  const targetId = await resolveProfileTargetId(userIdOrUsername);
  return Boolean(targetId && targetId !== requestingUserId && await areUsersBlocked(requestingUserId, targetId));
};

export const sendResourceUnavailable = (res: Response): void => {
  res.status(404).json({
    error: 'This resource is unavailable.',
    code: 'resource_unavailable',
    retryable: false,
  });
};
