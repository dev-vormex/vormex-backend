import axios, { AxiosError } from "axios";
import type { GitHubRepo, GitHubLanguageResponse, TopRepo, GitHubContributionCalendar, GitHubSyncResult } from "../../../shared/types/github.types";
import { encryptToken } from "../../security/encryption.util";
import { prisma } from "../../../config/prisma";
import { requestWithBreaker } from "../../http/http-client-with-breaker.util";
import { cacheService } from "../../cache/cache.service";
import { GitHubGraphQlResponse, checkRateLimit, getGitHubUserProfile, getUserRepositories, getRepositoryLanguages, calculateLanguageStats } from "./exchange-code-for-token.service";

/**
 * Selects top repositories based on star count
 * Pure JavaScript function - no API calls
 * @param repos - Array of GitHubRepo objects
 * @returns Array of TopRepo objects (top 6 by stars)
 */
export function selectTopRepositories(repos: GitHubRepo[]): TopRepo[] {
  // Sort by stargazers_count descending
  const sortedRepos = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count);

  // Take top 6 repos only
  const topRepos = sortedRepos.slice(0, 6);

  // Map to TopRepo format
  return topRepos.map((repo) => ({
    name: repo.name,
    url: repo.html_url,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    language: repo.language,
    description: repo.description
      ? repo.description.length > 100
        ? repo.description.substring(0, 100) + '...'
        : repo.description
      : null,
    updatedAt: repo.updated_at,
  }));
}

/**
 * Fetch a user's public GitHub contribution calendar.
 * Uses the GraphQL API so we can mirror the profile-style contribution graph.
 */
export async function getGitHubContributionCalendar(
  username: string,
  accessToken: string
): Promise<GitHubContributionCalendar> {
  try {
    const response = await requestWithBreaker<GitHubGraphQlResponse>('github', 'contribution_calendar', {
      method: 'POST',
      url: 'https://api.github.com/graphql',
      data: {
        query: `
          query GetContributionCalendar($username: String!) {
            user(login: $username) {
              contributionsCollection {
                contributionYears
                contributionCalendar {
                  colors
                  totalContributions
                  months {
                    firstDay
                    name
                    totalWeeks
                    year
                  }
                  weeks {
                    firstDay
                    contributionDays {
                      color
                      contributionCount
                      contributionLevel
                      date
                      weekday
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { username },
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    }, { connectTimeoutMs: 5_000, requestTimeoutMs: 12_000 });

    if (response.data?.errors?.length) {
      const firstError = response.data.errors[0];
      throw new Error(firstError?.message || 'GitHub contribution query failed');
    }

    const contributionCollection =
      response.data?.data?.user?.contributionsCollection;
    const contributionCalendar = contributionCollection?.contributionCalendar;

    if (!contributionCalendar) {
      throw new Error(`No contribution calendar found for GitHub user '${username}'`);
    }

    return {
      colors: contributionCalendar.colors || [],
      contributionYears: contributionCollection.contributionYears || [],
      months: (contributionCalendar.months || []).map((month: any) => ({
        firstDay: month.firstDay,
        name: month.name,
        totalWeeks: month.totalWeeks,
        year: month.year,
      })),
      totalContributions: contributionCalendar.totalContributions || 0,
      weeks: (contributionCalendar.weeks || []).map((week: any) => ({
        firstDay: week.firstDay,
        contributionDays: (week.contributionDays || []).map((day: any) => ({
          color: day.color,
          contributionCount: day.contributionCount,
          contributionLevel: day.contributionLevel,
          date: day.date,
          weekday: day.weekday,
        })),
      })),
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
      }
    }

    throw error;
  }
}

/**
 * Main orchestrator function to sync GitHub data for a user
 * Fetches profile, repos, languages, calculates stats, and saves to database
 * @param userId - User ID from database
 * @param accessToken - GitHub OAuth access token
 * @returns GitHubSyncResult with success status and stats
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    })
  );

  return results;
}

export async function syncGitHubData(
  userId: string,
  accessToken: string
): Promise<GitHubSyncResult> {
  const startTime = Date.now();
  console.log(`Starting GitHub sync for user ${userId}`);

  try {
    // Check rate limit before starting
    await checkRateLimit(accessToken);

    // Step 1: Get GitHub user profile
    const profile = await getGitHubUserProfile(accessToken);
    console.log(`Fetched profile for user: ${profile.login}`);

    // Step 2: Get all repositories
    const repos = await getUserRepositories(profile.login, accessToken);
    console.log(`Fetched ${repos.length} repositories`);

    // Step 3: Fetch language data for repos (limit to top 50 by stars to avoid rate limits)
    const sortedRepos = [...repos].sort((a, b) => b.stargazers_count - a.stargazers_count);
    const reposToProcess = sortedRepos.slice(0, 50);

    console.log(`Processing language data for ${reposToProcess.length} repositories...`);
    // A sequential loop can take longer than mobile/proxy request deadlines for
    // users with many repositories. Keep concurrency bounded to avoid bursts.
    const allLanguageData = (
      await mapWithConcurrency(reposToProcess, 6, async (repo) => {
        try {
          return await getRepositoryLanguages(profile.login, repo.name, accessToken);
        } catch (error) {
          // One inaccessible repository must not fail the complete account sync.
          console.warn(
            `Failed to fetch languages for ${repo.name}:`,
            error instanceof Error ? error.message : 'Unknown error'
          );
          return null;
        }
      })
    ).filter((languages): languages is GitHubLanguageResponse => languages !== null);

    // Step 4: Calculate language statistics
    const languageStats = calculateLanguageStats(allLanguageData);
    console.log(`Found ${languageStats.length} languages`);

    // Step 5: Select top repositories
    const topRepos = selectTopRepositories(repos);

    // Step 6: Calculate totals
    const totalStars = repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
    const totalForks = repos.reduce((sum, repo) => sum + repo.forks_count, 0);

    let contributionCalendar: GitHubContributionCalendar | null = null;
    try {
      contributionCalendar = await getGitHubContributionCalendar(profile.login, accessToken);
      console.log(
        `Fetched ${contributionCalendar.totalContributions} GitHub contributions for ${profile.login}`
      );
    } catch (error) {
      console.warn(
        `Failed to fetch contribution calendar for ${profile.login}:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }

    // Convert languageStats array to object format for JSON storage
    const topLanguagesObject: Record<string, { bytes: number; percentage: number }> = {};
    for (const stat of languageStats) {
      topLanguagesObject[stat.name] = {
        bytes: stat.bytes,
        percentage: stat.percentage,
      };
    }

    // Step 7: Upsert GitHubStats in database
    await prisma.gitHubStats.upsert({
      where: { userId },
      create: {
        userId,
        totalPublicRepos: profile.public_repos,
        totalStars,
        totalForks,
        followers: profile.followers,
        following: profile.following,
        topLanguages: topLanguagesObject,
        topRepos: topRepos as any,
        ...(contributionCalendar ? { contributionData: contributionCalendar as any } : {}),
        lastCalculatedAt: new Date(),
      },
      update: {
        totalPublicRepos: profile.public_repos,
        totalStars,
        totalForks,
        followers: profile.followers,
        following: profile.following,
        topLanguages: topLanguagesObject,
        topRepos: topRepos as any,
        ...(contributionCalendar ? { contributionData: contributionCalendar as any } : {}),
        lastCalculatedAt: new Date(),
      },
    });

    // Step 8: Update User model with GitHub info
    const encryptedToken = encryptToken(accessToken);
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

    // GitHub is part of the cached profile sections. Make the just-synced data
    // visible before the API reports success, even if the worker is unavailable.
    await cacheService.invalidateTags(`user:${userId}`);
    await cacheService.delPattern(`profile:sections:*:${userId}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`GitHub sync completed for user ${userId} in ${duration}s`);

    return {
      success: true,
      message: 'GitHub data synced successfully',
      stats: {
        username: profile.login,
        publicRepos: profile.public_repos,
        totalStars,
        totalForks,
        followers: profile.followers,
        following: profile.following,
        languagesCount: languageStats.length,
        topReposCount: topRepos.length,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error(`GitHub sync failed for user ${userId}:`, errorMessage);

    // Don't expose access tokens in error messages
    const safeErrorMessage = errorMessage.replace(/token[=:]\s*[\w-]+/gi, 'token=***');

    return {
      success: false,
      message: 'GitHub sync failed',
      error: safeErrorMessage,
    };
  }
}
