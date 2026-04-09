import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { exchangeCodeForToken, getGitHubUserProfile, syncGitHubData } from '../services/github.service';
import { encryptToken, decryptToken } from '../utils/encryption.util';
import { generateStateToken, validateStateToken, deleteStateToken } from '../utils/state.util';

// Environment variables
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL;

/**
 * Start GitHub OAuth flow
 * GET /api/integrations/github/start
 * Protected route - requires JWT authentication
 */
export const startGitHubOAuth = async (
  req: AuthenticatedRequest,
  res: Response<{ authUrl: string } | ErrorResponse>
): Promise<void> => {
  try {
    // Validate environment variables
    if (!GITHUB_CLIENT_ID || !GITHUB_CALLBACK_URL) {
      console.error('Missing GitHub OAuth environment variables');
      res.status(500).json({
        error: 'GitHub OAuth is not configured. Please contact support.',
      });
      return;
    }

    // Get userId from authenticated request
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'User not authenticated',
      });
      return;
    }

    // Convert userId to string (in case it's a number from JWT)
    const userId = String(req.user.userId);

    // Generate state token for CSRF protection
    const state = generateStateToken(userId);

    // Build GitHub authorization URL
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_CALLBACK_URL)}&state=${state}&scope=read:user`;

    console.log(`GitHub OAuth started for user ${userId}`);

    res.status(200).json({
      authUrl,
    });
  } catch (error) {
    console.error('Error starting GitHub OAuth:', error);
    res.status(500).json({
      error: 'Failed to start GitHub OAuth flow',
    });
  }
};

/**
 * Handle GitHub OAuth callback
 * GET /api/integrations/github/callback
 * Public route - called by GitHub
 */
export const handleGitHubCallback = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { code, state } = req.query;

    // Validate required parameters
    if (!code || typeof code !== 'string') {
      console.error('GitHub callback missing code parameter');
      res.redirect(`${FRONTEND_URL || 'http://localhost:3001'}/profile?github=error&message=missing_code`);
      return;
    }

    if (!state || typeof state !== 'string') {
      console.error('GitHub callback missing state parameter');
      res.redirect(`${FRONTEND_URL || 'http://localhost:3001'}/profile?github=error&message=missing_state`);
      return;
    }

    // Validate state token (CSRF protection)
    const stateData = validateStateToken(state);
    if (!stateData) {
      console.error('Invalid or expired state token');
      res.redirect(`${FRONTEND_URL || 'http://localhost:3001'}/profile?github=error&message=invalid_state`);
      return;
    }

    const userId = stateData.userId;

    // Delete state token after validation (one-time use)
    deleteStateToken(state);

    try {
      // Exchange code for access token
      const accessToken = await exchangeCodeForToken(code);
      console.log(`GitHub OAuth token exchanged for user ${userId}`);

      // Get GitHub user profile
      const profile = await getGitHubUserProfile(accessToken);
      console.log(`GitHub profile fetched for user ${userId}: ${profile.login}`);

      // Encrypt access token
      const encryptedToken = encryptToken(accessToken);

      // Update User in database
      await prisma.user.update({
        where: { id: userId },
        data: {
          githubUsername: profile.login,
          githubId: profile.id.toString(),
          githubConnected: true,
          githubAvatarUrl: profile.avatar_url,
          githubProfileUrl: profile.html_url,
          githubAccessToken: encryptedToken,
          githubLastSyncedAt: new Date(),
        },
      });

      console.log(`GitHub account connected for user ${userId}`);

      // Trigger background sync (don't wait for completion)
      syncGitHubData(userId, accessToken).catch((error) => {
        console.error(`Background GitHub sync failed for user ${userId}:`, error);
      });

      // Redirect to frontend with success
      res.redirect(`${FRONTEND_URL || 'http://localhost:3001'}/profile?github=connected`);
    } catch (error) {
      console.error(`GitHub OAuth callback error for user ${userId}:`, error);

      // Determine error type
      let errorMessage = 'oauth_failed';
      if (error instanceof Error) {
        if (error.message.includes('Invalid authorization code')) {
          errorMessage = 'invalid_code';
        } else if (error.message.includes('rate limit')) {
          errorMessage = 'rate_limit';
        } else if (error.message.includes('network')) {
          errorMessage = 'network_error';
        }
      }

      res.redirect(`${FRONTEND_URL || 'http://localhost:3001'}/profile?github=error&message=${errorMessage}`);
    }
  } catch (error) {
    console.error('Unexpected error in GitHub callback:', error);
    res.redirect(`${FRONTEND_URL || 'http://localhost:3001'}/profile?github=error&message=unexpected_error`);
  }
};

/**
 * Manually sync GitHub stats
 * POST /api/integrations/github/sync
 * Protected route - requires JWT authentication
 */
export const syncGitHubStats = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string; stats?: any; syncedAt: Date } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'User not authenticated',
      });
      return;
    }

    const userId = String(req.user.userId);

    // Fetch user from database
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        githubConnected: true,
        githubAccessToken: true,
      },
    });

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    // Check if GitHub is connected
    if (!user.githubConnected || !user.githubAccessToken) {
      res.status(400).json({
        error: 'GitHub account not connected. Please connect first.',
      });
      return;
    }

    // Decrypt access token
    let accessToken: string;
    try {
      accessToken = decryptToken(user.githubAccessToken);
    } catch (error) {
      console.error(`Failed to decrypt token for user ${userId}:`, error);
      res.status(500).json({
        error: 'Failed to decrypt GitHub token. Please reconnect your account.',
      });
      return;
    }

    // Sync GitHub data
    const result = await syncGitHubData(userId, accessToken);

    if (!result.success) {
      // Check if token expired
      if (result.error?.includes('401') || result.error?.includes('Invalid or expired')) {
        // Update user to mark as disconnected
        await prisma.user.update({
          where: { id: userId },
          data: {
            githubConnected: false,
          },
        });

        res.status(401).json({
          error: 'GitHub token expired. Please reconnect.',
        });
        return;
      }

      // Check if rate limit exceeded
      if (result.error?.includes('rate limit') || result.error?.includes('429')) {
        res.status(429).json({
          error: 'GitHub API rate limit exceeded. Please try again later.',
        });
        return;
      }

      // Generic sync failure
      res.status(500).json({
        error: result.error || 'GitHub sync failed',
      });
      return;
    }

    // Success
    res.status(200).json({
      message: 'GitHub stats synced successfully',
      stats: result.stats,
      syncedAt: new Date(),
    });
  } catch (error) {
    console.error('Error syncing GitHub stats:', error);
    res.status(500).json({
      error: 'Internal server error during GitHub sync',
    });
  }
};

/**
 * Disconnect GitHub account
 * POST /api/integrations/github/disconnect
 * Protected route - requires JWT authentication
 */
export const disconnectGitHub = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'User not authenticated',
      });
      return;
    }

    const userId = String(req.user.userId);

    // Update User in database
    await prisma.user.update({
      where: { id: userId },
      data: {
        githubConnected: false,
        githubAccessToken: null,
        // Keep other fields for reference (githubUsername, githubId, etc.)
      },
    });

    // Optionally delete GitHubStats (commented out to keep historical data)
    // await prisma.gitHubStats.deleteMany({
    //   where: { userId },
    // });

    console.log(`GitHub disconnected for user ${userId}`);

    res.status(200).json({
      message: 'GitHub disconnected successfully',
    });
  } catch (error) {
    console.error('Error disconnecting GitHub:', error);
    res.status(500).json({
      error: 'Failed to disconnect GitHub account',
    });
  }
};

/**
 * Get GitHub stats for authenticated user
 * GET /api/integrations/github/stats
 * Protected route - requires JWT authentication
 */
export const getGitHubStats = async (
  req: AuthenticatedRequest,
  res: Response<{
    connected: boolean;
    username: string | null;
    stats: any;
    lastSyncedAt: Date | null;
  } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({
        error: 'User not authenticated',
      });
      return;
    }

    const userId = String(req.user.userId);

    // Fetch user and GitHubStats
    const [user, githubStats] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          githubConnected: true,
          githubUsername: true,
          githubLastSyncedAt: true,
        },
      }),
      prisma.gitHubStats.findUnique({
        where: { userId },
      }),
    ]);

    if (!user) {
      res.status(404).json({
        error: 'User not found',
      });
      return;
    }

    if (!githubStats) {
      res.status(404).json({
        error: 'No GitHub stats found. Please connect GitHub first.',
      });
      return;
    }

    res.status(200).json({
      connected: user.githubConnected || false,
      username: user.githubUsername,
      stats: {
        totalPublicRepos: githubStats.totalPublicRepos,
        totalStars: githubStats.totalStars,
        totalForks: githubStats.totalForks,
        followers: githubStats.followers,
        following: githubStats.following,
        topLanguages: githubStats.topLanguages,
        topRepos: githubStats.topRepos,
      },
      lastSyncedAt: user.githubLastSyncedAt,
    });
  } catch (error) {
    console.error('Error fetching GitHub stats:', error);
    res.status(500).json({
      error: 'Failed to fetch GitHub stats',
    });
  }
};

