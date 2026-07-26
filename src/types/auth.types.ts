import { Request } from 'express';
import type { CoarseLocationDTO } from '../utils/location-dto.util';

/**
 * Register Request Body Interface
 */
export interface RegisterRequestBody {
  email: string;
  password: string;
  name: string;
  username?: string; // Optional in API: backend can generate one when the client doesn't provide it
  college?: string;
  branch?: string;
}

/**
 * Login Request Body Interface
 * Supports login with email OR username
 */
export interface LoginRequestBody {
  email?: string; // Optional: use email OR username
  username?: string; // Optional: use email OR username
  emailOrUsername?: string; // Alternative: single field for email or username
  password: string;
}

/**
 * User Response Interface (without sensitive data)
 * Includes all user fields except: password, githubAccessToken, resetToken, verificationToken, and their expiry fields
 */
export interface UserResponse {
  id: string | number; // Supports both String (UUID) and Number (legacy) IDs
  email: string;
  username: string; // Username for profile URLs and @mentions
  name: string;
  profileImage?: string | null;
  bio?: string | null;
  college?: string | null;
  branch?: string | null;
  graduationYear?: number | null;
  isVerified: boolean;
  authProvider: string;
  googleId?: string | null;
  appleId?: string | null;
  
  // GitHub Integration Fields
  githubUsername?: string | null;
  githubId?: string | null;
  githubConnected: boolean;
  githubAvatarUrl?: string | null;
  githubProfileUrl?: string | null;
  githubLastSyncedAt?: Date | null;
  
  // Enhanced Profile Fields
  headline?: string | null;
  bannerImageUrl?: string | null;
  location?: CoarseLocationDTO | null;
  currentYear?: number | null;
  degree?: string | null;
  portfolioUrl?: string | null;
  linkedinUrl?: string | null;
  otherSocialUrls?: any | null; // JSON type
  isOpenToOpportunities: boolean;
  interests?: string[]; // Array of interests
  onboardingCompleted?: boolean;
  identityTrustLevel?: string;
  verificationBadges?: string[];
  isPremium?: boolean;
  canUseAgent?: boolean;
  canAccessProfileCustomization?: boolean;
  profileBadgeStyle?: string | null;
  profileTheme?: string;
  premiumDisplayAmount?: string;
  
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Auth Success Response Interface
 */
export interface AuthSuccessResponse {
  user: UserResponse;
  token?: string;
  refreshToken?: string;
  csrfToken?: string;
  message?: string;
  requiresVerification?: boolean;
  session?: {
    id: string;
    expiresAt: string;
  };
}

/**
 * Error Response Interface
 */
export interface ErrorResponse {
  error: string;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  suspendedUntil?: string;
  details?: string;
  requiresVerification?: boolean; // Optional flag for email verification requirement
}

/**
 * Extended Request Interface with user property
 * Used in authenticated routes
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string | number; // Supports both String (UUID) and Number (legacy) IDs
    sessionId?: string;
  };
  /** Resolved once by global auth and reused by route-level auth middleware. */
  authState?:
    | {
        status: 'authenticated';
        source: 'authorization' | 'cookie';
        user: {
          userId: string | number;
          sessionId?: string;
        };
      }
    | {
        status: 'anonymous';
        reason: 'missing' | 'invalid_format' | 'invalid_csrf' | 'invalid_token';
        errorMessage?: string;
      };
}

/**
 * Forgot Password Request Body Interface
 */
export interface ForgotPasswordRequestBody {
  email: string;
}

/**
 * Reset Password Request Body Interface
 */
export interface ResetPasswordRequestBody {
  token?: string;
  newPassword: string;
}

/**
 * Success Message Response Interface
 */
export interface SuccessMessageResponse {
  message: string;
}

/**
 * Google Sign-In Request Body Interface
 */
export interface GoogleSignInRequestBody {
  idToken: string;
}

/**
 * Resend Verification Request Body Interface
 */
export interface ResendVerificationRequestBody {
  email: string;
}

/**
 * Verify Email OTP Request Body Interface
 */
export interface VerifyEmailOtpRequestBody {
  email: string;
  code: string;
}
