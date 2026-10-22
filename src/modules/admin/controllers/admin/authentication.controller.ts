import { encryptToken, decryptToken } from "../../../../infrastructure/security/encryption.util";
import speakeasy from "speakeasy";
import { prisma } from "../../../../config/prisma";
import { Response } from "express";
import { isAuthSessionTwoFactorVerified, getAuthSession, revokeAllAuthSessions, markAuthSessionTwoFactorVerified } from "../../../auth/services/auth-session.service";
import QRCode from "qrcode";
import { AuthRequest } from "./support.controller";

export function encryptAdminTwoFactorSecret(secret: string): string {
  return `enc:${encryptToken(secret)}`;
}

export function decryptAdminTwoFactorSecret(secret: string | null | undefined): string | null {
  if (!secret) {
    return null;
  }

  if (secret.startsWith('enc:')) {
    return decryptToken(secret.slice(4));
  }

  return secret;
}

export function verifyTotpToken(secret: string, token: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1,
  });
}

export async function getAdminTwoFactorUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      isAdmin: true,
      adminTwoFactorEnabled: true,
      adminTwoFactorSecret: true,
      adminTwoFactorPendingSecret: true,
      adminTwoFactorPendingAt: true,
    },
  });
}

// ============================================
// AUTH & VERIFY
// ============================================

export const verifyAdmin = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: String(req.user.userId) },
      select: {
        id: true,
        email: true,
        name: true,
        profileImage: true,
        role: true,
        isAdmin: true,
        adminTwoFactorEnabled: true,
      },
    });

    if (!user || !user.isAdmin) {
      res.status(403).json({ error: 'Admin access required', isAdmin: false });
      return;
    }

    const twoFactorVerified = user.adminTwoFactorEnabled
      ? await isAuthSessionTwoFactorVerified(req.user.sessionId, String(req.user.userId))
      : true;

    res.json({
      isAdmin: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profileImage: user.profileImage,
        role: user.role,
      },
      twoFactorEnabled: user.adminTwoFactorEnabled,
      requiresTwoFactor: user.adminTwoFactorEnabled && !twoFactorVerified,
    });
  } catch (error) {
    console.error('verifyAdmin error:', error);
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
};

// ============================================
// 2FA
// ============================================

export const setup2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await getAdminTwoFactorUser(userId);
    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const session = req.user?.sessionId
      ? await getAuthSession(req.user.sessionId)
      : null;
    const sessionAgeMs = session ? Date.now() - new Date(session.createdAt).getTime() : Infinity;
    if (!session || session.userId !== userId || sessionAgeMs > 10 * 60 * 1000) {
      res.status(401).json({
        error: 'Sign in again before changing administrator two-factor authentication.',
        code: 'recent_authentication_required',
      });
      return;
    }

    if (user.adminTwoFactorEnabled) {
      const currentToken = String(req.body?.currentToken || '').trim();
      const activeSecret = decryptAdminTwoFactorSecret(user.adminTwoFactorSecret);
      if (!/^\d{6}$/.test(currentToken) || !activeSecret || !verifyTotpToken(activeSecret, currentToken)) {
        res.status(401).json({
          error: 'Your current two-factor code is required to replace this factor.',
          code: 'current_two_factor_required',
        });
        return;
      }
    }

    const secret = speakeasy.generateSecret({
      issuer: 'Vormex',
      name: `Vormex Admin (${user.email})`,
      length: 32,
    });

    if (!secret.base32 || !secret.otpauth_url) {
      res.status(500).json({ error: 'Failed to generate 2FA secret' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        adminTwoFactorPendingSecret: encryptAdminTwoFactorSecret(secret.base32),
        adminTwoFactorPendingAt: new Date(),
      },
    });

    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      secret: secret.base32,
      qrCode,
      message: 'Scan the QR code and verify a 6-digit code to enable 2FA.',
    });
  } catch (error) {
    console.error('setup2FA error:', error);
    res.status(500).json({ error: 'Failed to setup 2FA' });
  }
};

export const verify2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const token = String(req.body?.token || '').trim();

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!/^\d{6}$/.test(token)) {
      res.status(400).json({ error: 'A valid 6-digit code is required' });
      return;
    }

    const user = await getAdminTwoFactorUser(userId);
    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const pendingAgeMs = user.adminTwoFactorPendingAt
      ? Date.now() - user.adminTwoFactorPendingAt.getTime()
      : Infinity;
    const secret = pendingAgeMs <= 10 * 60 * 1000
      ? decryptAdminTwoFactorSecret(user.adminTwoFactorPendingSecret)
      : null;
    if (!secret || !verifyTotpToken(secret, token)) {
      res.status(401).json({ error: 'Invalid two-factor code' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        adminTwoFactorEnabled: true,
        adminTwoFactorSecret: user.adminTwoFactorPendingSecret,
        adminTwoFactorPendingSecret: null,
        adminTwoFactorPendingAt: null,
      },
    });
    await revokeAllAuthSessions(userId);

    res.json({
      success: true,
      reauthRequired: true,
      message: '2FA verified. Sign in again to continue.',
    });
  } catch (error) {
    console.error('verify2FA error:', error);
    res.status(500).json({ error: 'Failed to verify 2FA' });
  }
};

export const validate2FA = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const token = String(req.body?.token || '').trim();

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!/^\d{6}$/.test(token)) {
      res.status(400).json({ error: 'A valid 6-digit code is required' });
      return;
    }

    const user = await getAdminTwoFactorUser(userId);
    if (!user?.isAdmin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    if (!user.adminTwoFactorEnabled) {
      res.json({ success: true, verified: true });
      return;
    }

    const secret = decryptAdminTwoFactorSecret(user.adminTwoFactorSecret);
    if (!secret || !verifyTotpToken(secret, token)) {
      res.status(401).json({ error: 'Invalid two-factor code' });
      return;
    }

    await markAuthSessionTwoFactorVerified(req.user?.sessionId, userId);

    res.json({ success: true, verified: true });
  } catch (error) {
    console.error('validate2FA error:', error);
    res.status(500).json({ error: 'Failed to validate 2FA' });
  }
};
