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
}

export interface GitHubSyncResult {
  success: boolean;
  message: string;
  stats?: any;
  error?: string;
}

