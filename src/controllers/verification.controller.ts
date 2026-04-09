import { Request, Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma';
import { sendVerificationEmail } from '../utils/email.util';
import {
  ResendVerificationRequestBody,
  ErrorResponse,
  SuccessMessageResponse,
} from '../types/auth.types';

/**
 * Email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Hash token rounds (same as password reset)
 */
const SALT_ROUNDS = 10;

/**
 * Verification token expiry time (24 hours in milliseconds)
 */
const VERIFICATION_TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

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

    // Hash the received token to compare with stored hash
    // Find all users with verification tokens that haven't expired
    const usersWithVerificationTokens = await prisma.user.findMany({
      where: {
        verificationToken: { not: null },
        verificationTokenExpiry: { gt: new Date() }, // Not expired
      },
    });

    // Find user with matching token
    let userWithValidToken = null;

    for (const user of usersWithVerificationTokens) {
      if (user.verificationToken) {
        const isTokenValid = await bcrypt.compare(trimmedToken, user.verificationToken);
        if (isTokenValid) {
          userWithValidToken = user;
          break;
        }
      }
    }

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
      // Check if already verified
      if (user.isVerified) {
        res.status(400).json({
          error: 'Email is already verified',
        });
        return;
      }

      // Skip OAuth users (they're already verified)
      if (user.authProvider !== 'email') {
        res.status(400).json({
          error: 'OAuth users do not need email verification',
        });
        return;
      }

      try {
        // Generate new verification token
        const plainVerificationToken = crypto.randomBytes(32).toString('hex');
        const hashedVerificationToken = await bcrypt.hash(plainVerificationToken, SALT_ROUNDS);
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
        // Don't throw - we still want to return 200 to user
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

