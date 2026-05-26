// @ts-nocheck
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import {
  exchangeGoogleAuthorizationCodeForIdToken,
  verifyGoogleToken,
  GoogleTokenPayload,
} from '../utils/google.util';
import { generateUsernameFromName, normalizeUsername } from '../utils/username.util';
import { hashEmail } from '../utils/email-hash.util';
import {
  authTokensForResponse,
  issueAuthTransport,
} from '../services/auth-transport.service';
import { buildUserResponse, safeUserResponseSelect } from '../services/user-response.service';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { processPeopleYouKnowJoinForUser } from '../services/people-you-know-join.service';
import { invalidateAuthUserStatus } from '../services/auth-user-status-cache.service';
import {
  GoogleSignInRequestBody,
  AuthSuccessResponse,
  ErrorResponse,
} from '../types/auth.types';

/**
 * Generate a unique username for a user
 * 
 * @param baseUsername - Base username to start with
 * @returns Unique username
 */
async function generateUniqueUsername(baseUsername: string): Promise<string> {
  let username = normalizeUsername(baseUsername);
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    // Check if username is available
    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    // If username is available, use it
    if (!existing) {
      return username;
    }

    // Username taken, add/increment suffix
    const match = username.match(/^(.+)_(\d+)$/);
    if (match) {
      // Has existing suffix, increment it
      const base = match[1];
      const suffix = parseInt(match[2], 10);
      username = `${base}_${suffix + 1}`;
    } else {
      // No suffix, add one
      username = `${username}_1`;
    }

    attempts++;
  }

  // Fallback: use timestamp
  const timestamp = Date.now().toString().slice(-6);
  return `${baseUsername}_${timestamp}`;
}

async function createOAuthSession(req: Request, res: Response, userId: string | number) {
  return issueAuthTransport(req, res, userId);
}

/**
 * Google Sign-In - Authenticate user with Google OAuth
 * 
 * POST /api/auth/google
 * Body: { idToken }
 * 
 * Flow:
 * 1. Verify Google ID token
 * 2. Find or create user based on googleId/email
 * 3. Return user and JWT token
 */
export const googleSignIn = async (
  req: Request<{}, AuthSuccessResponse | ErrorResponse, GoogleSignInRequestBody>,
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { idToken } = req.body;

    // Validate idToken is provided
    if (!idToken) {
      res.status(400).json({
        error: 'idToken is required',
      });
      return;
    }

    // Validate idToken is a non-empty string
    if (typeof idToken !== 'string' || idToken.trim().length === 0) {
      res.status(400).json({
        error: 'idToken must be a non-empty string',
      });
      return;
    }

    // Verify Google token and extract payload
    let googlePayload: GoogleTokenPayload;
    try {
      googlePayload = await verifyGoogleToken(idToken.trim());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Google token verification failed';
      console.error('Google token verification error:', error);
      res.status(401).json({
        error: errorMessage,
      });
      return;
    }

    const { email, name, picture, googleId } = googlePayload;

    // Try to find user by googleId first
    let user = await prisma.user.findUnique({
      where: { googleId },
      select: {
        ...safeUserResponseSelect,
        emailHash: true,
        isBanned: true,
      },
    });

    // Case A: User found by googleId (existing Google user)
    if (user) {
      if (user.isBanned) {
        res.status(403).json({
          error: 'User account is disabled',
          code: 'account_disabled',
        });
        return;
      }

      // Update user if name or profileImage changed
      const needsUpdate =
        user.name !== name || user.profileImage !== picture || !user.emailHash;

      if (needsUpdate) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            name,
            profileImage: picture || null,
            emailHash: hashEmail(email),
          },
          select: {
            ...safeUserResponseSelect,
            isBanned: true,
          },
        });
      }

      const authSession = await createOAuthSession(req, res, user.id);

      const userResponse = await buildUserResponse(user);

      res.status(200).json({
        user: userResponse,
        ...authTokensForResponse(req, authSession),
      });
      return;
    }

    // Case B: User not found by googleId, check by email
    const existingUserByEmail = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        authProvider: true,
        isBanned: true,
      },
    });

    if (existingUserByEmail) {
      if (existingUserByEmail.isBanned) {
        res.status(403).json({
          error: 'User account is disabled',
          code: 'account_disabled',
        });
        return;
      }

      // If email exists with different auth provider (email/password)
      if (existingUserByEmail.authProvider !== 'google') {
        res.status(409).json({
          error: 'This email is already registered with email/password. Please login with your password or reset it.',
        });
        return;
      }

      // If email exists with authProvider === "google" but no googleId (edge case)
      // Link Google account by updating with googleId
      const updatedUser = await prisma.user.update({
        where: { id: existingUserByEmail.id },
        data: {
          googleId,
          name,
          profileImage: picture || null,
          isVerified: true, // Google verifies emails
          emailHash: hashEmail(email),
        },
        select: {
          ...safeUserResponseSelect,
          isBanned: true,
        },
      });
      await invalidateAuthUserStatus(updatedUser.id);

      const authSession = await createOAuthSession(req, res, updatedUser.id);

      const userResponse = await buildUserResponse(updatedUser);

      res.status(200).json({
        user: userResponse,
        ...authTokensForResponse(req, authSession),
      });
      return;
    }

    // Case C: New user (email doesn't exist)
    // Auto-generate username from name
    const baseUsername = generateUsernameFromName(name);
    const uniqueUsername = await generateUniqueUsername(baseUsername);

    // Create new user with Google OAuth
    const newUser = await prisma.user.create({
      data: {
        email,
        emailHash: hashEmail(email),
        username: uniqueUsername,
        name,
        profileImage: picture || null,
        googleId,
        authProvider: 'google',
        password: null, // OAuth users don't have passwords
        isVerified: true, // Google already verifies emails
        college: null,
        branch: null,
        bio: null,
        graduationYear: null,
      },
      select: safeUserResponseSelect,
    });

    try {
      await processPeopleYouKnowJoinForUser(newUser.id);
    } catch (peopleYouKnowError) {
      console.error('Failed to process joined-contact matches after Google signup:', peopleYouKnowError);
    }

    queueMatchAvailabilityNotifications(newUser.id, 'google_signup');

    const authSession = await createOAuthSession(req, res, newUser.id);

    const userResponse = await buildUserResponse(newUser);

    res.status(201).json({
      user: userResponse,
      ...authTokensForResponse(req, authSession),
    });
  } catch (error) {
    console.error('Google sign-in error:', error);
    res.status(500).json({
      error: 'Internal server error during Google sign-in',
    });
  }
};

export const googleCodeSignIn = async (
  req: Request,
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { code, codeVerifier, redirectUri } = req.body || {};

    if (
      typeof code !== 'string' ||
      typeof codeVerifier !== 'string' ||
      typeof redirectUri !== 'string'
    ) {
      res.status(400).json({
        error: 'Code, code verifier, and redirect URI are required',
      });
      return;
    }

    const idToken = await exchangeGoogleAuthorizationCodeForIdToken({
      code,
      codeVerifier,
      redirectUri,
    });

    req.body = { idToken };
    await googleSignIn(req as any, res);
  } catch (error) {
    console.error('Google authorization code sign-in error:', error);
    res.status(401).json({
      error: error instanceof Error ? error.message : 'Google sign-in failed',
    });
  }
};
