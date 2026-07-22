import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import {
  ensureEmailServiceReady,
  sendPasswordResetEmail,
  toPublicEmailDeliveryFailure,
} from '../utils/email.util';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  isLikelyOpaqueToken,
  validatePasswordStrength,
  verifyLegacyBcryptToken,
} from '../utils/auth-security.util';
import { revokeAllAuthSessions } from '../services/auth-session.service';
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
 * Reset token expiry time (1 hour in milliseconds)
 */
const RESET_TOKEN_EXPIRY = 3600000; // 1 hour

async function findUserByResetToken(token: string) {
  const now = new Date();
  const tokenHash = hashOpaqueToken(token);
  const user = await prisma.user.findFirst({
    where: {
      resetToken: tokenHash,
      resetTokenExpiry: { gt: now },
    },
  });

  if (user) {
    return user;
  }

  const usersWithLegacyResetTokens = await prisma.user.findMany({
    where: {
      resetToken: { startsWith: '$2' },
      resetTokenExpiry: { gt: now },
    },
    take: 100,
  });

  for (const legacyUser of usersWithLegacyResetTokens) {
    if (await verifyLegacyBcryptToken(token, legacyUser.resetToken)) {
      return legacyUser;
    }
  }

  return null;
}

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

    // Check provider readiness before looking up the account. This prevents a
    // broken email configuration from being reported as success while keeping
    // the response independent of whether the address is registered.
    try {
      await ensureEmailServiceReady();
    } catch (emailError) {
      console.error('Email service is unavailable during password reset:', emailError);
      const failure = toPublicEmailDeliveryFailure(emailError);
      res.status(failure.statusCode).json(failure.body);
      return;
    }

    // Find user by email (case-insensitive)
    const user = await prisma.user.findUnique({
      where: { email: trimmedEmail },
    });

    // Always return success message (security: don't reveal if email exists)
    // Only proceed if user exists and has a password (not OAuth-only user)
    if (user && user.password) {
      let resetTokenStored = false;

      try {
        // Generate secure random token and store only a deterministic hash.
        const plainToken = generateOpaqueToken();
        const hashedToken = hashOpaqueToken(plainToken);

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
        resetTokenStored = true;

        // Send email with PLAIN token (user needs unhashed version)
        await sendPasswordResetEmail(trimmedEmail, plainToken);

        console.log('Password reset token generated for user:', trimmedEmail);
      } catch (error) {
        if (resetTokenStored) {
          try {
            await prisma.user.update({
              where: { id: user.id },
              data: {
                resetToken: null,
                resetTokenExpiry: null,
              },
            });
          } catch (rollbackError) {
            console.error('Failed to rollback password reset token after email failure:', rollbackError);
          }
        }

        // Log error but still return success message (security)
        console.error('Error processing password reset request:', error);

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
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 * 
 * Validates token (from query), checks expiry, and updates password
 */
export const resetPassword = async (
  req: Request<{}, SuccessMessageResponse | ErrorResponse, ResetPasswordRequestBody>,
  res: Response<SuccessMessageResponse | ErrorResponse>
): Promise<void> => {
  try {
    const token = req.body?.token || (req.query.token as string | undefined);
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
    const candidatePassword = newPassword;

    // Validate token is not empty
    if (!trimmedToken) {
      res.status(400).json({
        error: 'Token is required',
      });
      return;
    }

    if (!isLikelyOpaqueToken(trimmedToken)) {
      res.status(400).json({
        error: 'Invalid or expired reset token',
      });
      return;
    }

    const userWithValidToken = await findUserByResetToken(trimmedToken);

    // Check if valid token found
    if (!userWithValidToken) {
      res.status(400).json({
        error: 'Invalid or expired reset token',
      });
      return;
    }

    const passwordError = validatePasswordStrength(candidatePassword, [
      userWithValidToken.email,
      userWithValidToken.name,
      userWithValidToken.username,
    ]);
    if (passwordError) {
      res.status(400).json({
        error: passwordError,
      });
      return;
    }

    // Hash new password
    const hashedPassword = await hashPassword(candidatePassword);

    // Update user: set new password, clear reset token and expiry
    await prisma.user.update({
      where: { id: userWithValidToken.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });
    await revokeAllAuthSessions(userWithValidToken.id);

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
