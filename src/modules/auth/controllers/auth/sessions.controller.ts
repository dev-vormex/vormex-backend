import { AuthenticatedRequest, UserResponse, ErrorResponse, AuthSuccessResponse } from "../../types/auth.types";
import { Response, Request } from "express";
import { prisma } from "../../../../config/prisma";
import { safeUserResponseSelect, buildUserResponse } from "../../../profiles/services/user-response.service";
import { getCookie, REFRESH_TOKEN_COOKIE, clearAuthCookies, setAuthCookies } from "../../utils/auth-cookie.util";
import { rotateAuthSession, revokeAuthSession, revokeAllAuthSessions } from "../../services/auth-session.service";
import { generateAccessToken, getAccessTokenTtlSeconds } from "../../utils/jwt.util";
import { type IssuedAuthTransport, authTokensForResponse } from "../../services/auth-transport.service";
import { recordUserDeviceFromRequest } from "../../../safety/services/trust-safety.service";

/**
 * Get current authenticated user profile
 * 
 * GET /api/auth/me
 * Headers: Authorization: Bearer <token>
 */
export const getCurrentUser = async (
  req: AuthenticatedRequest,
  res: Response<UserResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'User not authenticated',
      });
      return;
    }

    const userId = String(req.user.userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: safeUserResponseSelect,
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    const userResponse = await buildUserResponse(user);

    res.status(200).json(userResponse);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Get current user error:', err.message, err.stack);
    res.status(500).json({
      error: 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { details: err.message }),
    });
  }
};

export const refreshSession = async (
  req: Request<{}, AuthSuccessResponse | ErrorResponse, { refreshToken?: string }>,
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const refreshToken = req.body?.refreshToken || getCookie(req, REFRESH_TOKEN_COOKIE);
    if (!refreshToken) {
      clearAuthCookies(res);
      res.status(400).json({ error: 'refreshToken is required' });
      return;
    }

    const rotated = await rotateAuthSession(refreshToken);
    if (!rotated) {
      clearAuthCookies(res);
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: rotated.userId },
      select: {
        ...safeUserResponseSelect,
        isBanned: true,
        safetySuspendedUntil: true,
      },
    });

    if (!user) {
      await revokeAuthSession(rotated.refreshToken);
      clearAuthCookies(res);
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (user.isBanned) {
      await revokeAllAuthSessions(user.id);
      clearAuthCookies(res);
      res.status(403).json({
        error: 'User account is disabled',
        code: 'account_disabled',
      });
      return;
    }

    if (user.safetySuspendedUntil && user.safetySuspendedUntil > new Date()) {
      await revokeAllAuthSessions(user.id);
      clearAuthCookies(res);
      res.status(403).json({
        error: 'User account is temporarily suspended',
        code: 'account_suspended',
        suspendedUntil: user.safetySuspendedUntil.toISOString(),
      });
      return;
    }

    if (user.authProvider === 'email' && !user.isVerified) {
      await revokeAllAuthSessions(user.id);
      clearAuthCookies(res);
      res.status(403).json({
        error: 'Please verify your email before continuing.',
        code: 'email_not_verified',
        requiresVerification: true,
      });
      return;
    }

    const { isBanned: _isBanned, ...safeUser } = user;
    const userResponse = await buildUserResponse(safeUser);

    const accessToken = generateAccessToken(rotated.userId, rotated.sessionId);
    const csrfToken = setAuthCookies(res, {
      accessToken,
      accessMaxAgeSeconds: getAccessTokenTtlSeconds(),
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.expiresAt,
      sessionId: rotated.sessionId,
    });
    const authTransport: IssuedAuthTransport = {
      token: accessToken,
      refreshToken: rotated.refreshToken,
      csrfToken,
      session: {
        id: rotated.sessionId,
        expiresAt: rotated.expiresAt.toISOString(),
      },
    };
    try {
      await recordUserDeviceFromRequest(req, rotated.userId);
    } catch (deviceError) {
      console.error('Failed to record refresh device:', deviceError);
    }

    res.status(200).json({
      user: userResponse,
      ...authTokensForResponse(req, authTransport),
    });
  } catch (error) {
    console.error('Refresh session error:', error);
    res.status(500).json({
      error: 'Internal server error during session refresh',
    });
  }
};

export const logout = async (
  req: Request<{}, { success: boolean } | ErrorResponse, { refreshToken?: string }>,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    const refreshToken = req.body?.refreshToken || getCookie(req, REFRESH_TOKEN_COOKIE);
    if (refreshToken) {
      await revokeAuthSession(refreshToken);
    }

    clearAuthCookies(res);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
};

export const logoutAll = async (
  req: AuthenticatedRequest,
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await revokeAllAuthSessions(userId);
    clearAuthCookies(res);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Logout all error:', error);
    res.status(500).json({ error: 'Failed to logout all sessions' });
  }
};
