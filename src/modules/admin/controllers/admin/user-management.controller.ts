import { Response } from "express";
import { normalizeProfileThemeForStorage, serializeProfileTheme } from "../../../profiles/constants/profile-themes";
import { prisma } from "../../../../config/prisma";
import { invalidateAuthUserStatus } from "../../../auth/services/auth-user-status-cache.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { recordSafetyEvent } from "../../../safety/services/trust-safety.service";
import { revokeAllAuthSessions } from "../../../auth/services/auth-session.service";
import { invalidateUserProximity } from "../../../proximity/services/proximity-privacy.service";
import { AuthRequest, normalizeOptionalString } from "./support.controller";

export const updateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const allowedFields = ['name', 'email', 'role', 'isVerified', 'college', 'branch', 'graduationYear', 'profileTheme'];
    const data: any = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'profileTheme') {
          try {
            data.profileTheme = normalizeProfileThemeForStorage(req.body[field]);
          } catch (error) {
            res.status(400).json({
              error: error instanceof Error ? error.message : 'Unsupported profile theme',
            });
            return;
          }
        } else {
          data[field] = req.body[field];
        }
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data,
    });
    if (Object.prototype.hasOwnProperty.call(data, 'isVerified')) {
      await invalidateAuthUserStatus(id);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'profileTheme')) {
      await cacheService.invalidateTags(`user:${id}`);
    }

    res.json({
      user: {
        ...user,
        profileTheme: serializeProfileTheme(user.profileTheme),
      },
      message: 'User updated successfully',
    });
  } catch (error) {
    console.error('updateUser error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

export const banUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const reason = normalizeOptionalString(req.body?.reason) || normalizeOptionalString(req.body?.banReason) || 'Admin ban';

    if (id === String(req.user.userId)) {
      res.status(400).json({ error: 'Cannot ban yourself' });
      return;
    }

    await prisma.user.update({
      where: { id },
      data: {
        isBanned: true,
        bannedReason: reason,
        safetySuspendedUntil: null,
        safetyRestrictedUntil: null,
      },
    });
    await recordSafetyEvent({
      actorId: String(req.user.userId),
      targetUserId: id,
      eventType: 'USER_BANNED',
      reason,
    });
    await invalidateAuthUserStatus(id);
    await revokeAllAuthSessions(id);
    await invalidateUserProximity(id, 'admin_ban');

    res.json({ message: 'User banned successfully' });
  } catch (error) {
    console.error('banUser error:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
};

export const unbanUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    await prisma.user.update({
      where: { id },
      data: {
        isBanned: false,
        bannedReason: null,
        safetySuspendedUntil: null,
        safetyRestrictedUntil: null,
      },
    });
    await recordSafetyEvent({
      actorId: String(req.user.userId),
      targetUserId: id,
      eventType: 'USER_UNBANNED',
    });
    await invalidateAuthUserStatus(id);

    res.json({ message: 'User unbanned successfully' });
  } catch (error) {
    console.error('unbanUser error:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
};

export const verifyUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    await prisma.user.update({
      where: { id },
      data: { isVerified: true },
    });
    await invalidateAuthUserStatus(id);

    res.json({ message: 'User verified successfully' });
  } catch (error) {
    console.error('verifyUser error:', error);
    res.status(500).json({ error: 'Failed to verify user' });
  }
};

export const deleteUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    if (id === String(req.user.userId)) {
      res.status(400).json({ error: 'Cannot delete yourself' });
      return;
    }

    await revokeAllAuthSessions(id);
    await invalidateUserProximity(id, 'account_deleted');
    await prisma.user.delete({ where: { id } });
    await invalidateAuthUserStatus(id);

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('deleteUser error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};
