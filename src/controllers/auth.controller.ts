import { Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma';
import { generateAccessToken } from '../utils/jwt.util';
import { sendVerificationEmail } from '../utils/email.util';
import {
  validateUsername,
  normalizeUsername,
  generateUsernameFromName,
} from '../utils/username.util';
import { hashEmail } from '../utils/email-hash.util';
import { recordActivity } from '../services/activity.service';
import {
  createAuthSession,
  revokeAllAuthSessions,
  revokeAuthSession,
  rotateAuthSession,
} from '../services/auth-session.service';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { processPeopleYouKnowJoinForUser } from '../services/people-you-know-join.service';
import { buildUserResponse } from '../services/user-response.service';
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

/**
 * Minimum password length
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Hash password rounds
 */
const SALT_ROUNDS = 10;

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

    // Fetch user from database (all fields)
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    // Remove sensitive fields before sending response
    // Exclude: password, githubAccessToken, resetToken, verificationToken, and their expiry fields
    const {
      password: _password,
      githubAccessToken,
      resetToken: _resetToken,
      resetTokenExpiry: _resetTokenExpiry,
      verificationToken: _verificationToken,
      verificationTokenExpiry: _verificationTokenExpiry,
      ...safeUser
    } = user;

    const userResponse = await buildUserResponse(safeUser);

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
  req: { body: RegisterRequestBody },
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { email, password, name, username, college, branch } = req.body;

    // Validate required fields
    if (!email || !password || !name) {
      res.status(400).json({
        error: 'Email, password, and name are required',
      });
      return;
    }

    const normalizedEmail = email.toLowerCase();

    // Validate email format
    if (!EMAIL_REGEX.test(email)) {
      res.status(400).json({
        error: 'Invalid email format',
      });
      return;
    }

    // Validate password length
    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
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
      normalizedUsername = await generateUniqueUsernameFromName(name);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Generate verification token
    const plainVerificationToken = crypto.randomBytes(32).toString('hex');
    const hashedVerificationToken = await bcrypt.hash(plainVerificationToken, SALT_ROUNDS);
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        emailHash: hashEmail(normalizedEmail),
        username: normalizedUsername,
        password: hashedPassword,
        name,
        college: college || null,
        branch: branch || null,
        authProvider: 'email',
        isVerified: false,
        verificationToken: hashedVerificationToken,
        verificationTokenExpiry,
      },
    });

    // Send verification email (don't block registration if email fails)
    try {
      await sendVerificationEmail(normalizedEmail, plainVerificationToken, name);
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

    // Generate JWT token
    const session = await createAuthSession({
      userId: user.id,
      userAgent: (req as any)?.headers?.['user-agent'],
      ip: (req as any)?.ip,
    });
    const token = generateAccessToken(user.id, session.sessionId);

    // Remove sensitive fields before sending response
    // Note: password and verificationTokenExpiry from above are already used, so we rename them here to avoid conflict
      if (!user.emailHash) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            emailHash: hashEmail(user.email),
          },
        });
      }

      const {
      password: _password, // Rename to avoid conflict with req.body password
      githubAccessToken,
      resetToken,
      resetTokenExpiry: _resetTokenExpiry,
      verificationToken: _verificationToken,
      verificationTokenExpiry: _verificationTokenExpiry, // Rename to avoid conflict with local variable
      ...safeUser
    } = user;

    const userResponse = await buildUserResponse(safeUser);

    // Return success response
    res.status(201).json({
      user: userResponse,
      token,
      refreshToken: session.refreshToken,
      session: {
        id: session.sessionId,
        expiresAt: session.expiresAt.toISOString(),
      },
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
  req: { body: LoginRequestBody },
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { email, username, emailOrUsername, password } = req.body;

    // Validate required fields
    if (!password) {
      res.status(400).json({
        error: 'Password is required',
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
    const normalizedIdentifier = isEmail 
      ? loginIdentifier.toLowerCase() 
      : normalizeUsername(loginIdentifier);

    // Find user by email or username
    const user = await prisma.user.findFirst({
      where: isEmail
        ? { email: normalizedIdentifier }
        : { username: normalizedIdentifier },
    });

    // Check if user exists
    if (!user) {
      res.status(401).json({
        error: 'Invalid email or password',
      });
      return;
    }

    // Check if user has a password (not OAuth user)
    if (!user.password) {
      res.status(401).json({
        error: 'This account uses OAuth authentication. Please sign in with your OAuth provider.',
      });
      return;
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      res.status(401).json({
        error: 'Invalid email or password',
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

    // Generate JWT token
    if (!user.emailHash) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailHash: hashEmail(user.email) },
      });
    }

    const session = await createAuthSession({
      userId: user.id,
      userAgent: (req as any)?.headers?.['user-agent'],
      ip: (req as any)?.ip,
    });
    const token = generateAccessToken(user.id, session.sessionId);

    // Remove sensitive fields before sending response
    // Note: password from req.body is already used, so we rename it here to avoid conflict
    const {
      password: _password, // Rename to avoid conflict with req.body password
      githubAccessToken,
      resetToken,
      resetTokenExpiry: _resetTokenExpiry,
      verificationToken: _verificationToken,
      verificationTokenExpiry: _verificationTokenExpiry,
      ...safeUser
    } = user;

    const userResponse = await buildUserResponse(safeUser);

    // Record login activity and update streak (non-blocking)
    recordActivity(user.id, 'login', 1).catch(console.error);
    updateEngagementStreak(user.id, 'login').catch(console.error);

    // Return success response
    res.status(200).json({
      user: userResponse,
      token,
      refreshToken: session.refreshToken,
      session: {
        id: session.sessionId,
        expiresAt: session.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error during login',
    });
  }
};

export const refreshSession = async (
  req: { body: { refreshToken?: string } },
  res: Response<AuthSuccessResponse | ErrorResponse>
): Promise<void> => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' });
      return;
    }

    const rotated = await rotateAuthSession(refreshToken);
    if (!rotated) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: rotated.userId },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const {
      password: _password,
      githubAccessToken,
      resetToken,
      resetTokenExpiry: _resetTokenExpiry,
      verificationToken: _verificationToken,
      verificationTokenExpiry: _verificationTokenExpiry,
      ...safeUser
    } = user;

    const userResponse = await buildUserResponse(safeUser);

    res.status(200).json({
      user: userResponse,
      token: generateAccessToken(rotated.userId, rotated.sessionId),
      refreshToken: rotated.refreshToken,
      session: {
        id: rotated.sessionId,
        expiresAt: rotated.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Refresh session error:', error);
    res.status(500).json({
      error: 'Internal server error during session refresh',
    });
  }
};

export const logout = async (
  req: { body?: { refreshToken?: string } },
  res: Response<{ success: boolean } | ErrorResponse>
): Promise<void> => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' });
      return;
    }

    await revokeAuthSession(refreshToken);
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
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Logout all error:', error);
    res.status(500).json({ error: 'Failed to logout all sessions' });
  }
};
