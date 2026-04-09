/**
 * Activity tracking types for user engagement and streak calculation
 */

export type ActivityType =
  | 'post'
  | 'article'
  | 'comment'
  | 'forum_question'
  | 'forum_answer'
  | 'like'
  | 'message'
  | 'short_video'
  | 'connection'
  | 'login';

export interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: Date | null;
  totalActiveDays: number;
}

export interface ActivityHeatmapDay {
  date: string; // YYYY-MM-DD format
  activityCount: number;
  isActive: boolean;
  level: number; // 0, 1, 2, or 3 (GitHub-style contribution levels)
  breakdown?: {
    posts: number;
    articles: number;
    comments: number;
    forumQuestions: number;
    forumAnswers: number;
    likes: number;
    messages: number;
  };
}

export interface ActivityHeatmapResponse {
  days: ActivityHeatmapDay[];
  stats: {
    totalContributions: number;
    currentStreak: number;
    longestStreak: number;
    contributionLevels: {
      level0: number; // 0 contributions
      level1: number; // 1-3 contributions
      level2: number; // 4-9 contributions
      level3: number; // 10+ contributions
    };
  };
}

export interface ActivitySummary {
  totalContent: number;
  totalForumActivity: number;
  totalEngagement: number;
  streak: StreakInfo;
  xpAndLevel: {
    xp: number;
    level: number;
    xpToNextLevel: number;
  };
}

