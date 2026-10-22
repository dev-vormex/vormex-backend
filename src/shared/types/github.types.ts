/**
 * TypeScript interfaces for GitHub API responses and internal data structures
 */

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  name: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
  following: number;
}

export interface GitHubRepo {
  name: string;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  description: string | null;
  updated_at: string;
  private: boolean;
}

export interface GitHubLanguageResponse {
  [language: string]: number; // language name -> bytes
}

export interface LanguageStat {
  name: string;
  bytes: number;
  percentage: number;
}

export interface TopRepo {
  name: string;
  url: string;
  stars: number;
  forks: number;
  language: string | null;
  description: string | null;
  updatedAt: string;
}

export interface GitHubContributionDay {
  color: string;
  contributionCount: number;
  contributionLevel:
    | 'NONE'
    | 'FIRST_QUARTILE'
    | 'SECOND_QUARTILE'
    | 'THIRD_QUARTILE'
    | 'FOURTH_QUARTILE';
  date: string;
  weekday: number;
}

export interface GitHubContributionWeek {
  firstDay: string;
  contributionDays: GitHubContributionDay[];
}

export interface GitHubContributionMonth {
  firstDay: string;
  name: string;
  totalWeeks: number;
  year: number;
}

export interface GitHubContributionCalendar {
  colors: string[];
  contributionYears: number[];
  months: GitHubContributionMonth[];
  totalContributions: number;
  weeks: GitHubContributionWeek[];
}

export interface GitHubSyncResult {
  success: boolean;
  message: string;
  stats?: any;
  error?: string;
}
