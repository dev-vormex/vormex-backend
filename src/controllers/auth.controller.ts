import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { generateAccessToken, getAccessTokenTtlSeconds } from '../utils/jwt.util';
import { sendVerificationEmail } from '../utils/email.util';
import {
  validateUsername,
  normalizeUsername,
  generateUsernameFromName,
} from '../utils/username.util';
import { hashEmail } from '../utils/email-hash.util';
import {
  compareWithDummyPassword,
  getPasswordMaxLength,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  passwordHashNeedsRehash,
  validatePasswordStrength,
  verifyPassword,
} from '../utils/auth-security.util';
import {
  clearAuthCookies,
  getCookie,
  REFRESH_TOKEN_COOKIE,
  setAuthCookies,
} from '../utils/auth-cookie.util';
import { recordActivity } from '../services/activity.service';
import {
  revokeAllAuthSessions,
  revokeAuthSession,
  rotateAuthSession,
} from '../services/auth-session.service';
import {
  authTokensForResponse,
  issueAuthTransport,
  type IssuedAuthTransport,
} from '../services/auth-transport.service';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { processPeopleYouKnowJoinForUser } from '../services/people-you-know-join.service';
import { buildUserResponse, safeUserResponseSelect } from '../services/user-response.service';
import { updateEngagementStreak } from './engagement.controller';
import {
  RegisterRequestBody,
  LoginRequestBody,
  AuthSuccessResponse,
  ErrorResponse,
  UserResponse,
  AuthenticatedRequest,
} from '../types/auth.types';

/**
 * Email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function generateUniqueUsernameFromName(name: string): Promise<string> {
  let username = normalizeUsername(generateUsernameFromName(name));
  let attempts = 0;

  while (attempts < 100) {
    const existingUser = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!existingUser) {
      return username;
    }

    const suffix = Math.floor(1000 + Math.random() * 9000);
    username = `${username.slice(0, 25)}_${suffix}`.slice(0, 30);
    attempts += 1;
  }

  return `user_${Date.now().toString(36)}_${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 30);
}

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

/**
 * Register a new user with email and password
 * 
 * POST /api/auth/register
 * Body: { email, password, name, college?, branch? }
 */
export const register = async (
  req: Request<{}, AuthSuccessResponse | ErrorResponse, RegisterRequestBody>,
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { email, password, name, username, college, branch } = req.body;

    // Validate required fields
    if (!email || !password || !name?.trim()) {
      res.status(400).json({
        error: 'Email, password, and name are required',
      });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const displayName = name.trim();

    // Validate email format
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      res.status(400).json({
        error: 'Invalid email format',
      });
      return;
    }

    // Validate password strength
    const passwordError = validatePasswordStrength(password, [normalizedEmail, displayName, username]);
    if (passwordError) {
      res.status(400).json({
        error: passwordError,
      });
      return;
    }

    // Check if email already exists
    const existingUserByEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUserByEmail) {
      res.status(409).json({
        error: 'User with this email already exists',
      });
      return;
    }

    let normalizedUsername: string;
    if (username) {
      normalizedUsername = normalizeUsername(username);
      const usernameValidation = validateUsername(normalizedUsername);
      if (!usernameValidation.valid) {
        res.status(400).json({
          error: usernameValidation.error || 'Invalid username format',
        });
        return;
      }

      const existingUserByUsername = await prisma.user.findUnique({
        where: { username: normalizedUsername },
      });

      if (existingUserByUsername) {
        res.status(409).json({
          error: 'Username already taken',
        });
        return;
      }
    } else {
      normalizedUsername = await generateUniqueUsernameFromName(displayName);
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Generate verification token
    const plainVerificationToken = generateOpaqueToken();
    const hashedVerificationToken = hashOpaqueToken(plainVerificationToken);
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        emailHash: hashEmail(normalizedEmail),
        username: normalizedUsername,
        password: hashedPassword,
        name: displayName,
        college: college || null,
        branch: branch || null,
        authProvider: 'email',
        isVerified: false,
        verificationToken: hashedVerificationToken,
        verificationTokenExpiry,
      },
      select: safeUserResponseSelect,
    });

    // Send verification email (don't block registration if email fails)
    try {
      await sendVerificationEmail(normalizedEmail, plainVerificationToken, displayName);
    } catch (emailError) {
      // Log error but don't fail registration
      console.error('Failed to send verification email:', emailError);
      // User can still use the app and request resend verification later
    }

    try {
      await processPeopleYouKnowJoinForUser(user.id);
    } catch (peopleYouKnowError) {
      console.error('Failed to process joined-contact matches after registration:', peopleYouKnowError);
    }

    queueMatchAvailabilityNotifications(user.id, 'signup');

    const userResponse = await buildUserResponse(user);

    // Return success response
    res.status(201).json({
      user: userResponse,
      message: 'Registration successful. Please verify your email before logging in.',
      requiresVerification: true,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Internal server error during registration',
    });
  }
};

/**
 * Login user with email and password
 * 
 * POST /api/auth/login
 * Body: { email, password }
 */
export const login = async (
  req: Request<{}, AuthSuccessResponse | ErrorResponse, LoginRequestBody>,
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { email, username, emailOrUsername, password } = req.body;

    // Validate required fields
    if (!password || typeof password !== 'string') {
      res.status(400).json({
        error: 'Password is required',
      });
      return;
    }

    if (password.length > getPasswordMaxLength()) {
      res.status(401).json({
        error: 'Invalid email or password',
      });
      return;
    }

    // Determine login identifier (email or username)
    let loginIdentifier: string | undefined;
    if (emailOrUsername) {
      loginIdentifier = emailOrUsername;
    } else if (email) {
      loginIdentifier = email;
    } else if (username) {
      loginIdentifier = username;
    }

    if (!loginIdentifier) {
      res.status(400).json({
        error: 'Email or username is required',
      });
      return;
    }

    // Determine if loginIdentifier is email (contains @) or username
    const isEmail = loginIdentifier.includes('@');
    const trimmedIdentifier = loginIdentifier.trim();
    const normalizedIdentifier = isEmail
      ? trimmedIdentifier.toLowerCase()
      : normalizeUsername(loginIdentifier);

    // Find user by email or username
    const user = await prisma.user.findFirst({
      where: isEmail
        ? { email: normalizedIdentifier }
        : { username: normalizedIdentifier },
      select: {
        ...safeUserResponseSelect,
        password: true,
        emailHash: true,
        isBanned: true,
      },
    });

    // Check if user exists
    if (!user) {
      await compareWithDummyPassword(password);
      res.status(401).json({
        error: 'Invalid email or password',
      });
      return;
    }

    // Check if user has a password (not OAuth user)
    if (!user.password) {
      await compareWithDummyPassword(password);
      res.status(401).json({
        error: 'Invalid email or password',
      });
      return;
    }

    // Verify password
    const isPasswordValid = await verifyPassword(password, user.password);

    if (!isPasswordValid) {
      res.status(401).json({
        error: 'Invalid email or password',
      });
      return;
    }

    if (user.isBanned) {
      res.status(403).json({
        error: 'User account is disabled',
        code: 'account_disabled',
      });
      return;
    }

    // Check if email is verified (only for email/password users)
    // Google OAuth users are automatically verified, so they can login
    if (!user.isVerified) {
      res.status(403).json({
        error: 'Please verify your email before logging in. Check your inbox for verification link.',
        requiresVerification: true,
      });
      return;
    }

    if (passwordHashNeedsRehash(user.password)) {
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { password: await hashPassword(password) },
        });
      } catch (rehashError) {
        console.error('Failed to upgrade password hash:', rehashError);
      }
    }

    // Generate JWT token
    if (!user.emailHash) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailHash: hashEmail(user.email) },
      });
    }

    const authTransport = await issueAuthTransport(req, res, user.id);

    const {
      password: _password,
      emailHash: _emailHash,
      isBanned: _isBanned,
      ...safeUser
    } = user;

    const userResponse = await buildUserResponse(safeUser);

    // Record login activity and update streak (non-blocking)
    recordActivity(user.id, 'login', 1).catch(console.error);
    updateEngagementStreak(user.id, 'login').catch(console.error);

    // Return success response
    res.status(200).json({
      user: userResponse,
      ...authTokensForResponse(req, authTransport),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error during login',
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
