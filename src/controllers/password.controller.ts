import { Request, Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma';
import { sendPasswordResetEmail } from '../utils/email.util';
import {
  ForgotPasswordRequestBody,
  ResetPasswordRequestBody,
  ErrorResponse,
  SuccessMessageResponse,
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

/**
 * Reset token expiry time (1 hour in milliseconds)
 */
const RESET_TOKEN_EXPIRY = 3600000; // 1 hour

/**
 * Forgot Password - Send password reset email
 * 
 * POST /api/auth/forgot-password
 * Body: { email }
 * 
 * Security: Always returns 200 success even if email doesn't exist
 * to prevent email enumeration attacks
 */
export const forgotPassword = async (
  req: Request<{}, SuccessMessageResponse | ErrorResponse, ForgotPasswordRequestBody>,
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

    // Find user by email (case-insensitive)
    const user = await prisma.user.findUnique({
      where: { email: trimmedEmail },
    });

    // Always return success message (security: don't reveal if email exists)
    // Only proceed if user exists and has a password (not OAuth-only user)
    if (user && user.password) {
      try {
        // Generate secure random token
        const plainToken = crypto.randomBytes(32).toString('hex');

        // Hash token before storing in database
        const hashedToken = await bcrypt.hash(plainToken, SALT_ROUNDS);

        // Set expiry time (1 hour from now)
        const resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_EXPIRY);

        // Update user with hashed token and expiry
        await prisma.user.update({
          where: { id: user.id },
          data: {
            resetToken: hashedToken,
            resetTokenExpiry,
          },
        });

        // Send email with PLAIN token (user needs unhashed version)
        await sendPasswordResetEmail(trimmedEmail, plainToken);

        console.log('Password reset token generated for user:', trimmedEmail);
      } catch (error) {
        // Log error but still return success message (security)
        console.error('Error processing password reset request:', error);
        // Don't throw - we still want to return 200 to user
      }
    }

    // Always return success message (even if email doesn't exist)
    res.status(200).json({
      message: 'If email exists, password reset link has been sent',
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    // Still return success to prevent email enumeration
    res.status(200).json({
      message: 'If email exists, password reset link has been sent',
    });
  }
};

/**
 * Reset Password - Reset password using token
 * 
 * POST /api/auth/reset-password?token=<reset-token>
 * Body: { newPassword }
 * 
 * Validates token (from query), checks expiry, and updates password
 */
export const resetPassword = async (
  req: Request<{}, SuccessMessageResponse | ErrorResponse, ResetPasswordRequestBody>,
  res: Response<SuccessMessageResponse | ErrorResponse>
): Promise<void> => {
  try {
    // Get token from query parameters
    const token = req.query.token as string | undefined;
    const { newPassword } = req.body;

    // Validate required fields
    if (!token || !newPassword) {
      res.status(400).json({
        error: 'Token and new password are required',
      });
      return;
    }

    // Trim inputs
    const trimmedToken = token.trim();
    const trimmedPassword = newPassword.trim();

    // Validate token is not empty
    if (!trimmedToken) {
      res.status(400).json({
        error: 'Token is required',
      });
      return;
    }

    // Validate password length
    if (trimmedPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      });
      return;
    }

    // Hash the received token to compare with stored hash
    // We need to check all users with reset tokens and compare hashes
    const usersWithResetTokens = await prisma.user.findMany({
      where: {
        resetToken: { not: null },
        resetTokenExpiry: { gt: new Date() }, // Not expired
      },
    });

    // Find user with matching token
    let userWithValidToken = null;

    for (const user of usersWithResetTokens) {
      if (user.resetToken) {
        const isTokenValid = await bcrypt.compare(trimmedToken, user.resetToken);
        if (isTokenValid) {
          userWithValidToken = user;
          break;
        }
      }
    }

    // Check if valid token found
    if (!userWithValidToken) {
      res.status(400).json({
        error: 'Invalid or expired reset token',
      });
      return;
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(trimmedPassword, SALT_ROUNDS);

    // Update user: set new password, clear reset token and expiry
    await prisma.user.update({
      where: { id: userWithValidToken.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    console.log('Password reset successful for user:', userWithValidToken.email);

    // Return success message
    res.status(200).json({
      message: 'Password reset successful. You can now login with your new password.',
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      error: 'Internal server error during password reset',
    });
  }
};

