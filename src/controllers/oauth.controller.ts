// @ts-nocheck
import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { generateToken } from '../utils/jwt.util';
import { verifyGoogleToken, GoogleTokenPayload } from '../utils/google.util';
import { generateUsernameFromName, normalizeUsername } from '../utils/username.util';
import { hashEmail } from '../utils/email-hash.util';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { processPeopleYouKnowJoinForUser } from '../services/people-you-know-join.service';
import {
  GoogleSignInRequestBody,
  AuthSuccessResponse,
  ErrorResponse,
  UserResponse,
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
        id: true,
        email: true,
        emailHash: true,
        username: true,
        name: true,
        college: true,
        branch: true,
        profileImage: true,
        bio: true,
        graduationYear: true,
        isVerified: true,
        authProvider: true,
        googleId: true,
        appleId: true,
        githubConnected: true,
        githubUsername: true,
        githubId: true,
        githubAvatarUrl: true,
        githubProfileUrl: true,
        githubLastSyncedAt: true,
        headline: true,
        bannerImageUrl: true,
        location: true,
        currentYear: true,
        degree: true,
        portfolioUrl: true,
        linkedinUrl: true,
        otherSocialUrls: true,
        isOpenToOpportunities: true,
        interests: true,
        onboardingCompleted: true,
        createdAt: true,
        updatedAt: true,
        // Explicitly exclude password
      },
    });

    // Case A: User found by googleId (existing Google user)
    if (user) {
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
            id: true,
            email: true,
            username: true,
            name: true,
            college: true,
            branch: true,
            profileImage: true,
            bio: true,
            graduationYear: true,
            isVerified: true,
            authProvider: true,
            googleId: true,
            appleId: true,
            githubConnected: true,
            githubUsername: true,
            githubId: true,
            githubAvatarUrl: true,
            githubProfileUrl: true,
            githubLastSyncedAt: true,
            headline: true,
            bannerImageUrl: true,
            location: true,
            currentYear: true,
            degree: true,
            portfolioUrl: true,
            linkedinUrl: true,
            otherSocialUrls: true,
            isOpenToOpportunities: true,
            interests: true,
            onboardingCompleted: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      // Generate JWT token
      const token = generateToken(user.id);

      // Return user and token (user already has username from select)
      const userResponse: UserResponse = {
        id: user.id,
        email: user.email,
        username: user.username, // Username is required
        name: user.name,
        college: user.college,
        branch: user.branch,
        profileImage: user.profileImage,
        bio: user.bio,
        graduationYear: user.graduationYear,
        isVerified: user.isVerified,
        authProvider: user.authProvider,
        googleId: user.googleId || null,
        appleId: user.appleId || null,
        githubConnected: user.githubConnected || false,
        githubUsername: user.githubUsername || null,
        githubId: user.githubId || null,
        githubAvatarUrl: user.githubAvatarUrl || null,
        githubProfileUrl: user.githubProfileUrl || null,
        githubLastSyncedAt: user.githubLastSyncedAt || null,
        headline: user.headline || null,
        bannerImageUrl: user.bannerImageUrl || null,
        location: user.location || null,
        currentYear: user.currentYear || null,
        degree: user.degree || null,
        portfolioUrl: user.portfolioUrl || null,
        linkedinUrl: user.linkedinUrl || null,
        otherSocialUrls: user.otherSocialUrls || null,
        isOpenToOpportunities: user.isOpenToOpportunities || false,
        onboardingCompleted: user.onboardingCompleted ?? false,
        interests: user.interests || [],
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };

      res.status(200).json({
        user: userResponse,
        token,
      });
      return;
    }

    // Case B: User not found by googleId, check by email
    const existingUserByEmail = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        authProvider: true,
      },
    });

    if (existingUserByEmail) {
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
          id: true,
          email: true,
          username: true,
          name: true,
          college: true,
          branch: true,
          profileImage: true,
          bio: true,
          graduationYear: true,
          isVerified: true,
          authProvider: true,
          googleId: true,
          appleId: true,
          githubConnected: true,
          githubUsername: true,
          githubId: true,
          githubAvatarUrl: true,
          githubProfileUrl: true,
          githubLastSyncedAt: true,
          headline: true,
          bannerImageUrl: true,
          location: true,
          currentYear: true,
          degree: true,
          portfolioUrl: true,
          linkedinUrl: true,
          otherSocialUrls: true,
          isOpenToOpportunities: true,
          interests: true,
          onboardingCompleted: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Generate JWT token
      const token = generateToken(updatedUser.id);

      // Return user and token
      const userResponse: UserResponse = {
        id: updatedUser.id,
        email: updatedUser.email,
        username: updatedUser.username, // Username is required
        name: updatedUser.name,
        college: updatedUser.college,
        branch: updatedUser.branch,
        profileImage: updatedUser.profileImage,
        bio: updatedUser.bio,
        graduationYear: updatedUser.graduationYear,
        isVerified: updatedUser.isVerified,
        authProvider: updatedUser.authProvider,
        googleId: updatedUser.googleId || null,
        appleId: updatedUser.appleId || null,
        githubConnected: updatedUser.githubConnected || false,
        githubUsername: updatedUser.githubUsername || null,
        githubId: updatedUser.githubId || null,
        githubAvatarUrl: updatedUser.githubAvatarUrl || null,
        githubProfileUrl: updatedUser.githubProfileUrl || null,
        githubLastSyncedAt: updatedUser.githubLastSyncedAt || null,
        headline: updatedUser.headline || null,
        bannerImageUrl: updatedUser.bannerImageUrl || null,
        location: updatedUser.location || null,
        currentYear: updatedUser.currentYear || null,
        degree: updatedUser.degree || null,
        portfolioUrl: updatedUser.portfolioUrl || null,
        linkedinUrl: updatedUser.linkedinUrl || null,
        otherSocialUrls: updatedUser.otherSocialUrls || null,
        isOpenToOpportunities: updatedUser.isOpenToOpportunities || false,
        interests: updatedUser.interests || [],
        onboardingCompleted: updatedUser.onboardingCompleted ?? false,
        createdAt: updatedUser.createdAt,
        updatedAt: updatedUser.updatedAt,
      };

      res.status(200).json({
        user: userResponse,
        token,
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
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        college: true,
        branch: true,
        profileImage: true,
        bio: true,
        graduationYear: true,
        isVerified: true,
        authProvider: true,
        googleId: true,
        appleId: true,
        githubConnected: true,
        githubUsername: true,
        githubId: true,
        githubAvatarUrl: true,
        githubProfileUrl: true,
        githubLastSyncedAt: true,
        headline: true,
        bannerImageUrl: true,
        location: true,
        currentYear: true,
        degree: true,
        portfolioUrl: true,
        linkedinUrl: true,
        otherSocialUrls: true,
        isOpenToOpportunities: true,
        interests: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    try {
      await processPeopleYouKnowJoinForUser(newUser.id);
    } catch (peopleYouKnowError) {
      console.error('Failed to process joined-contact matches after Google signup:', peopleYouKnowError);
    }

    queueMatchAvailabilityNotifications(newUser.id, 'google_signup');

    // Generate JWT token
    const token = generateToken(newUser.id);

    // Return user and token
    const userResponse: UserResponse = {
      id: newUser.id,
      email: newUser.email,
      username: newUser.username, // Username is required
      name: newUser.name,
      college: newUser.college,
      branch: newUser.branch,
      profileImage: newUser.profileImage,
      bio: newUser.bio,
      graduationYear: newUser.graduationYear,
      isVerified: newUser.isVerified,
      authProvider: newUser.authProvider,
      googleId: newUser.googleId || null,
      appleId: newUser.appleId || null,
      githubConnected: newUser.githubConnected || false,
      githubUsername: newUser.githubUsername || null,
      githubId: newUser.githubId || null,
      githubAvatarUrl: newUser.githubAvatarUrl || null,
      githubProfileUrl: newUser.githubProfileUrl || null,
      githubLastSyncedAt: newUser.githubLastSyncedAt || null,
      headline: newUser.headline || null,
      bannerImageUrl: newUser.bannerImageUrl || null,
      location: newUser.location || null,
      currentYear: newUser.currentYear || null,
      degree: newUser.degree || null,
      portfolioUrl: newUser.portfolioUrl || null,
      linkedinUrl: newUser.linkedinUrl || null,
      otherSocialUrls: newUser.otherSocialUrls || null,
      isOpenToOpportunities: newUser.isOpenToOpportunities || false,
      interests: newUser.interests || [],
      onboardingCompleted: newUser.onboardingCompleted ?? false,
      createdAt: newUser.createdAt,
      updatedAt: newUser.updatedAt,
    };

    res.status(201).json({
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error('Google sign-in error:', error);
    res.status(500).json({
      error: 'Internal server error during Google sign-in',
    });
  }
};
