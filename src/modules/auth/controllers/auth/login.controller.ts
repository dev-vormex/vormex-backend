import { Request, Response } from "express";
import { AuthSuccessResponse, ErrorResponse, LoginRequestBody } from "../../types/auth.types";
import { getPasswordMaxLength, compareWithDummyPassword, verifyPassword, generateEmailOtpCode, hashEmailOtp, passwordHashNeedsRehash, hashPassword } from "../../utils/auth-security.util";
import { normalizeUsername } from "../../../../shared/utils/username.util";
import { prisma } from "../../../../config/prisma";
import { safeUserResponseSelect, buildUserResponse } from "../../../profiles/services/user-response.service";
import { ensureEmailServiceReady, sendVerificationEmail, toPublicEmailDeliveryFailure } from "../../../../infrastructure/email/email.util";
import { hashEmail } from "../../../../shared/utils/email-hash.util";
import { issueAuthTransport, authTokensForResponse } from "../../services/auth-transport.service";
import { recordActivity } from "../../../engagement/services/activity.service";
import { updateEngagementStreak } from "../../../engagement/services/streak.service";

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
        safetySuspendedUntil: true,
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

    if (user.safetySuspendedUntil && user.safetySuspendedUntil > new Date()) {
      res.status(403).json({
        error: 'User account is temporarily suspended',
        code: 'account_suspended',
        suspendedUntil: user.safetySuspendedUntil.toISOString(),
      });
      return;
    }

    // Check if email is verified (only for email/password users)
    // Google OAuth users are automatically verified, so they can login
    if (!user.isVerified) {
      const verificationCode = generateEmailOtpCode();
      const hashedVerificationToken = hashEmailOtp(user.email, verificationCode);
      const verificationTokenExpiry = new Date(Date.now() + 10 * 60 * 1000);

      try {
        await ensureEmailServiceReady();
        await prisma.user.update({
          where: { id: user.id },
          data: {
            verificationToken: hashedVerificationToken,
            verificationTokenExpiry,
          },
        });
        await sendVerificationEmail(user.email, verificationCode, user.name);
      } catch (emailError) {
        console.error('Failed to send verification email during login:', emailError);
        const failure = toPublicEmailDeliveryFailure(emailError);
        res.status(failure.statusCode).json(failure.body);
        return;
      }

      res.status(403).json({
        error: 'Please verify your email before logging in. Enter the 6-digit code sent to your inbox.',
        code: 'email_verification_required',
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
