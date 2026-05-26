import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { sendVerificationEmail } from '../utils/email.util';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isLikelyOpaqueToken,
  verifyLegacyBcryptToken,
} from '../utils/auth-security.util';
import {
  ResendVerificationRequestBody,
  ErrorResponse,
  SuccessMessageResponse,
} from '../types/auth.types';
import { invalidateAuthUserStatus } from '../services/auth-user-status-cache.service';

/**
 * Email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Verification token expiry time (24 hours in milliseconds)
 */
const VERIFICATION_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

async function findUserByVerificationToken(token: string) {
  const now = new Date();
  const tokenHash = hashOpaqueToken(token);
  const user = await prisma.user.findFirst({
    where: {
      verificationToken: tokenHash,
      verificationTokenExpiry: { gt: now },
    },
  });

  if (user) {
    return user;
  }

  const usersWithLegacyVerificationTokens = await prisma.user.findMany({
    where: {
      verificationToken: { startsWith: '$2' },
      verificationTokenExpiry: { gt: now },
    },
    take: 100,
  });

  for (const legacyUser of usersWithLegacyVerificationTokens) {
    if (await verifyLegacyBcryptToken(token, legacyUser.verificationToken)) {
      return legacyUser;
    }
  }

  return null;
}

/**
 * Verify Email - Verify user's email address with token
 * 
 * GET /api/auth/verify-email?token=<verification-token>
 * 
 * Validates token, checks expiry, and marks email as verified
 */
export const verifyEmail = async (
  req: Request<{}, SuccessMessageResponse | ErrorResponse>,
  res: Response<SuccessMessageResponse | ErrorResponse>
): Promise<void> => {
  try {
    // Get token from query parameters
    const token = req.query.token as string | undefined;

    // Validate token is provided
    if (!token) {
      res.status(400).json({
        error: 'Verification token is required',
      });
      return;
    }

    // Trim and validate token
    const trimmedToken = token.trim();

    if (!trimmedToken) {
      res.status(400).json({
        error: 'Verification token cannot be empty',
      });
      return;
    }

    if (!isLikelyOpaqueToken(trimmedToken)) {
      res.status(400).json({
        error: 'Invalid or expired verification token',
      });
      return;
    }

    const userWithValidToken = await findUserByVerificationToken(trimmedToken);

    // Check if valid token found
    if (!userWithValidToken) {
      res.status(400).json({
        error: 'Invalid or expired verification token',
      });
      return;
    }

    // Check if already verified (edge case)
    if (userWithValidToken.isVerified) {
      res.status(400).json({
        error: 'Email is already verified',
      });
      return;
    }

    // Update user: mark as verified, clear verification token and expiry
    await prisma.user.update({
      where: { id: userWithValidToken.id },
      data: {
        isVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null,
      },
    });
    await invalidateAuthUserStatus(userWithValidToken.id);

    console.log('Email verified successfully for user:', userWithValidToken.email);

    // Return success message
    res.status(200).json({
      message: 'Email verified successfully! You can now access all features.',
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({
      error: 'Internal server error during email verification',
    });
  }
};

/**
 * Resend Verification Email - Send new verification email to user
 * 
 * POST /api/auth/resend-verification
 * Body: { email }
 * 
 * Generates new verification token and sends email
 */
export const resendVerification = async (
  req: Request<{}, SuccessMessageResponse | ErrorResponse, ResendVerificationRequestBody>,
  res: Response<SuccessMessageResponse | ErrorResponse>
): Promise<void> => {
  try {
    const { email } = req.body;

    // Validate email is provided
    if (!email) {
      res.status(400).json({
        error: 'Email is required',
      });
      return;
    }

    // Trim and validate email format
    const trimmedEmail = email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      res.status(400).json({
        error: 'Invalid email format',
      });
      return;
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: trimmedEmail },
    });

    // Always return success message (security: don't reveal if email exists)
    // Only proceed if user exists
    if (user) {
      // Do not reveal account state for resend requests.
      if (user.isVerified) {
        res.status(200).json({
          message: 'Verification email sent. Please check your inbox.',
        });
        return;
      }

      // Skip OAuth users (they're already verified)
      if (user.authProvider !== 'email') {
        res.status(200).json({
          message: 'Verification email sent. Please check your inbox.',
        });
        return;
      }

      try {
        // Generate new verification token
        const plainVerificationToken = generateOpaqueToken();
        const hashedVerificationToken = hashOpaqueToken(plainVerificationToken);
        const verificationTokenExpiry = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY);

        // Update user with new verification token and expiry
        await prisma.user.update({
          where: { id: user.id },
          data: {
            verificationToken: hashedVerificationToken,
            verificationTokenExpiry,
          },
        });

        // Send verification email
        await sendVerificationEmail(trimmedEmail, plainVerificationToken, user.name);

        console.log('Verification email resent to:', trimmedEmail);
      } catch (error) {
        // Log error but still return success message (security)
        console.error('Error processing resend verification request:', error);

      }
    }

    // Always return success message (even if email doesn't exist)
    res.status(200).json({
      message: 'Verification email sent. Please check your inbox.',
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    // Still return success to prevent email enumeration
    res.status(200).json({
      message: 'Verification email sent. Please check your inbox.',
    });
  }
};
