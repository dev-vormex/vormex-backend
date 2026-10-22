import { Request, Response } from "express";
import { AuthSuccessResponse, ErrorResponse, RegisterRequestBody } from "../../types/auth.types";
import { validatePasswordStrength, hashPassword, generateEmailOtpCode, hashEmailOtp } from "../../utils/auth-security.util";
import { prisma } from "../../../../config/prisma";
import { ensureEmailServiceReady, toPublicEmailDeliveryFailure, sendVerificationEmail } from "../../../../infrastructure/email/email.util";
import { hashEmail } from "../../../../shared/utils/email-hash.util";
import { safeUserResponseSelect, buildUserResponse } from "../../../profiles/services/user-response.service";
import { recordUserDeviceFromRequest } from "../../../safety/services/trust-safety.service";
import { processPeopleYouKnowJoinForUser } from "../../../discovery/services/people-you-know-join.service";
import { queueMatchAvailabilityNotifications } from "../../../notifications/services/match-availability-notification.service";
import { EMAIL_REGEX, resolveRegistrationUsername } from "./support.controller";

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

    if (
      existingUserByEmail &&
      (existingUserByEmail.isVerified || existingUserByEmail.authProvider !== 'email')
    ) {
      res.status(409).json({
        error: 'User with this email already exists',
      });
      return;
    }

    try {
      await ensureEmailServiceReady();
    } catch (emailError) {
      console.error('Email service is unavailable during registration:', emailError);
      const failure = toPublicEmailDeliveryFailure(emailError);
      res.status(failure.statusCode).json(failure.body);
      return;
    }

    const usernameResult = await resolveRegistrationUsername({
      username,
      displayName,
      existingUserId: existingUserByEmail?.id,
      existingUsername: existingUserByEmail?.username,
    });
    if (!usernameResult.username) {
      res.status(usernameResult.status || 400).json({
        error: usernameResult.error || 'Invalid username format',
      });
      return;
    }
    const normalizedUsername = usernameResult.username;

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Generate email verification OTP
    const verificationCode = generateEmailOtpCode();
    const hashedVerificationToken = hashEmailOtp(normalizedEmail, verificationCode);
    const verificationTokenExpiry = new Date(Date.now() + 10 * 60 * 1000);

    if (existingUserByEmail) {
      const user = await prisma.user.update({
        where: { id: existingUserByEmail.id },
        data: {
          username: normalizedUsername,
          password: hashedPassword,
          name: displayName,
          college: college || existingUserByEmail.college || null,
          branch: branch || existingUserByEmail.branch || null,
          verificationToken: hashedVerificationToken,
          verificationTokenExpiry,
          emailHash: existingUserByEmail.emailHash || hashEmail(normalizedEmail),
        },
        select: safeUserResponseSelect,
      });

      try {
        await sendVerificationEmail(normalizedEmail, verificationCode, displayName);
      } catch (emailError) {
        console.error('Failed to resend verification email:', emailError);
        const failure = toPublicEmailDeliveryFailure(emailError);
        res.status(failure.statusCode).json(failure.body);
        return;
      }

      const userResponse = await buildUserResponse(user);
      try {
        await recordUserDeviceFromRequest(req, user.id, { lastLogin: false });
      } catch (deviceError) {
        console.error('Failed to record registration device:', deviceError);
      }

      res.status(200).json({
        user: userResponse,
        message: 'Verification code sent. Enter the 6-digit code sent to your email.',
        requiresVerification: true,
      });
      return;
    }

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
      await sendVerificationEmail(normalizedEmail, verificationCode, displayName);
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      const failure = toPublicEmailDeliveryFailure(emailError);
      res.status(failure.statusCode).json(failure.body);
      return;
    }

    try {
      await processPeopleYouKnowJoinForUser(user.id);
    } catch (peopleYouKnowError) {
      console.error('Failed to process joined-contact matches after registration:', peopleYouKnowError);
    }

    queueMatchAvailabilityNotifications(user.id, 'signup');

    const userResponse = await buildUserResponse(user);
    try {
      await recordUserDeviceFromRequest(req, user.id, { lastLogin: false });
    } catch (deviceError) {
      console.error('Failed to record registration device:', deviceError);
    }

    // Return success response
    res.status(201).json({
      user: userResponse,
      message: 'Registration successful. Enter the 6-digit code sent to your email.',
      requiresVerification: true,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      error: 'Internal server error during registration',
    });
  }
};
