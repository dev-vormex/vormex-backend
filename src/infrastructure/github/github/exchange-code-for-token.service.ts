import axios, { AxiosError } from "axios";
import type { GitHubUser, GitHubRepo, GitHubLanguageResponse, LanguageStat } from "../../../shared/types/github.types";
import { requestWithBreaker } from "../../http/http-client-with-breaker.util";

// Validate environment variables at module load
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;

const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

interface GitHubRateLimitResponse {
  resources?: {
    core?: {
      remaining?: number;
    };
  };
}

interface GitHubOAuthTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubApiUserResponse {
  login?: string;
  id?: number;
  avatar_url?: string;
  html_url?: string;
  name?: string | null;
  bio?: string | null;
  public_repos?: number;
  followers?: number;
  following?: number;
}

export interface GitHubGraphQlResponse {
  errors?: Array<{ message?: string }>;
  data?: {
    user?: {
      contributionsCollection?: {
        contributionYears?: number[];
        contributionCalendar?: {
          colors?: string[];
          totalContributions?: number;
          months?: Array<{
            firstDay: string;
            name: string;
            totalWeeks: number;
            year: number;
          }>;
          weeks?: Array<{
            firstDay: string;
            contributionDays?: Array<{
              color: string;
              contributionCount: number;
              contributionLevel: string;
              date: string;
              weekday: number;
            }>;
          }>;
        };
      };
    };
  };
}

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set in environment variables');
}

export /**
 * Checks GitHub API rate limit status
 * @param accessToken - GitHub OAuth access token
 * @throws Error if rate limit is nearly exceeded (< 10 requests remaining)
 */
async function checkRateLimit(accessToken: string): Promise<void> {
  try {
    const response = await requestWithBreaker<GitHubRateLimitResponse>('github', 'rate_limit', {
      method: 'GET',
      url: 'https://api.github.com/rate_limit',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

    const remaining = response.data.resources?.core?.remaining ?? 0;
    console.log(`GitHub API rate limit: ${remaining} requests remaining`);

    if (remaining < 10) {
      throw new Error('GitHub rate limit nearly exceeded. Please try again later.');
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 401) {
        throw new Error('Invalid or expired GitHub access token');
      }
    }
    throw error;
  }
}

/**
 * Exchanges OAuth authorization code for access token
 * @param code - Authorization code from GitHub OAuth callback
 * @returns Access token string
 * @throws Error if code is invalid or network request fails
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  try {
    const response = await requestWithBreaker<GitHubOAuthTokenResponse>('github', 'oauth_token', {
      method: 'POST',
      url: 'https://github.com/login/oauth/access_token',
      data: {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      },
      headers: {
        'Accept': 'application/json',
      },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

    if (response.data.error) {
      throw new Error(`GitHub OAuth error: ${response.data.error_description || response.data.error}`);
    }

    if (!response.data.access_token) {
      throw new Error('No access token received from GitHub');
    }

    return response.data.access_token;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 400) {
        throw new Error('Invalid authorization code. Code may have expired or already been used.');
      }
      if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ETIMEDOUT') {
        throw new Error('Network error: Could not connect to GitHub. Please try again.');
      }
    }
    throw error;
  }
}

/**
 * Fetches GitHub user profile information
 * @param accessToken - GitHub OAuth access token
 * @returns GitHubUser object with profile data
 * @throws Error if token is invalid or rate limit is exceeded
 */
export async function getGitHubUserProfile(accessToken: string): Promise<GitHubUser> {
  try {
    const response = await requestWithBreaker<GitHubApiUserResponse>('github', 'user_profile', {
      method: 'GET',
      url: 'https://api.github.com/user',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

    const user = response.data;

    // Validate response structure
    if (!user.login || !user.id) {
      throw new Error('Invalid GitHub user profile response');
    }

    return {
      login: user.login,
      id: user.id,
      avatar_url: user.avatar_url || '',
      html_url: user.html_url || '',
      name: user.name || null,
      bio: user.bio || null,
      public_repos: user.public_repos || 0,
      followers: user.followers || 0,
      following: user.following || 0,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 401) {
        throw new Error('Invalid or expired GitHub access token');
      }
      if (axiosError.response?.status === 403) {
        const remaining = axiosError.response.headers['x-ratelimit-remaining'];
        if (remaining === '0') {
          throw new Error('GitHub API rate limit exceeded. Please try again later.');
        }
        throw new Error('Access forbidden. Token may not have required permissions.');
      }
    }
    throw error;
  }
}

/**
 * Fetches all public repositories for a GitHub user with pagination support
 * @param username - GitHub username
 * @param accessToken - GitHub OAuth access token
 * @returns Array of GitHubRepo objects (only public repos)
 * @throws Error if user not found or rate limit exceeded
 */
export async function getUserRepositories(
  username: string,
  accessToken: string
): Promise<GitHubRepo[]> {
  try {
    const allRepos: GitHubRepo[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await requestWithBreaker<GitHubRepo[]>('github', 'user_repositories', {
        method: 'GET',
        url: `https://api.github.com/users/${username}/repos`,
        params: {
          type: 'owner',
          per_page: 100,
          sort: 'updated',
          page,
        },
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github+json',
        },
      }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

      const repos: GitHubRepo[] = response.data
        .filter((repo: any) => !repo.private) // Only public repos
        .map((repo: any) => ({
          name: repo.name,
          html_url: repo.html_url,
          stargazers_count: repo.stargazers_count || 0,
          forks_count: repo.forks_count || 0,
          language: repo.language || null,
          description: repo.description || null,
          updated_at: repo.updated_at,
          private: repo.private,
        }));

      allRepos.push(...repos);

      // Check for next page using Link header
      const linkHeader = response.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        page++;
      } else {
        hasMore = false;
      }
    }

    return allRepos;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 404) {
        throw new Error(`GitHub user '${username}' not found`);
      }
      if (axiosError.response?.status === 403) {
        const remaining = axiosError.response.headers['x-ratelimit-remaining'];
        if (remaining === '0') {
          throw new Error('GitHub API rate limit exceeded. Please try again later.');
        }
      }
    }
    throw error;
  }
}

/**
 * Fetches language statistics for a specific repository
 * @param owner - Repository owner username
 * @param repo - Repository name
 * @param accessToken - GitHub OAuth access token
 * @returns Object mapping language names to byte counts
 * @throws Error if repo not found or network error occurs
 */
export async function getRepositoryLanguages(
  owner: string,
  repo: string,
  accessToken: string
): Promise<GitHubLanguageResponse> {
  try {
    const response = await requestWithBreaker<GitHubLanguageResponse>('github', 'repository_languages', {
      method: 'GET',
      url: `https://api.github.com/repos/${owner}/${repo}/languages`,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
      },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

    // Handle empty response (repo with no code)
    if (!response.data || Object.keys(response.data).length === 0) {
      return {};
    }

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 404) {
        // Repo may have been deleted or is private - return empty object
        console.warn(`Repository ${owner}/${repo} not found or inaccessible`);
        return {};
      }
      if (axiosError.response?.status === 403) {
        const remaining = axiosError.response.headers['x-ratelimit-remaining'];
        if (remaining === '0') {
          throw new Error('GitHub API rate limit exceeded. Please try again later.');
        }
      }
    }
    throw error;
  }
}

/**
 * Calculates aggregated language statistics from multiple repositories
 * Pure JavaScript function - no API calls
 * @param allLanguageData - Array of language response objects from all repos
 * @returns Array of LanguageStat objects sorted by percentage (descending), top 10 only
 */
export function calculateLanguageStats(
  allLanguageData: GitHubLanguageResponse[]
): LanguageStat[] {
  // Create a Map to accumulate total bytes per language
  const languageMap = new Map<string, number>();

  // Loop through all repos' language data
  for (const repoLanguages of allLanguageData) {
    for (const [language, bytes] of Object.entries(repoLanguages)) {
      const currentBytes = languageMap.get(language) || 0;
      languageMap.set(language, currentBytes + bytes);
    }
  }

  // Calculate total bytes across ALL languages
  let totalBytes = 0;
  for (const bytes of languageMap.values()) {
    totalBytes += bytes;
  }

  // Convert to percentage and create LanguageStat array
  const languageStats: LanguageStat[] = [];
  for (const [name, bytes] of languageMap.entries()) {
    const percentage = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;
    languageStats.push({
      name,
      bytes,
      percentage: Math.round(percentage * 100) / 100, // Round to 2 decimal places
    });
  }

  // Sort by percentage descending
  languageStats.sort((a, b) => b.percentage - a.percentage);

  // Take top 10 languages only
  return languageStats.slice(0, 10);
}
