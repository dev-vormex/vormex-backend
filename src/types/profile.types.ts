/**
 * Profile API types for unified profile responses
 */

export interface UnifiedContentItem {
  id: string;
  contentType: 'post' | 'article' | 'forum_question' | 'forum_answer' | 'short_video';
  entityType?: 'post' | 'reel' | 'forum_question' | 'forum_answer';
  postType?: string;
  title?: string; // For articles and forum questions
  content: string;
  createdAt: Date;
  updatedAt: Date;

  // Engagement metrics
  likesCount?: number;
  commentsCount?: number;
  viewsCount?: number;

  // For forum answers - reference to question
  questionId?: string;
  questionTitle?: string;

  // For posts/articles
  images?: string[];
  mediaUrls?: string[];
  tags?: string[];
  videoUrl?: string;
  videoThumbnail?: string;
  defaultVideoId?: string;
  linkUrl?: string;
  linkTitle?: string;
  linkDescription?: string;
  linkDomain?: string;
  pollOptions?: Array<{
    id: string;
    text: string;
    votes: number;
    hasVoted: boolean;
    percentage: number;
  }>;
  pollEndsAt?: string;
  userVotedOptionId?: string | null;
  showResultsBeforeVote?: boolean;

  /** Celebration posts — metadata is required for profile activity cards */
  celebrationType?: string | null;
  celebrationGifUrl?: string | null;
  celebrationBadge?: string | null;
}

export interface UnifiedFeedResponse {
  items: UnifiedContentItem[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface FullProfileResponse {
  user: {
    id: string;
    username: string;
    name: string;
    email?: string; // Only if viewing own profile
    avatar: string | null;
    bannerImageUrl: string | null;
    headline: string | null;
    bio: string | null;
    location: string | null;
    college: string;
    degree: string | null;
    branch: string;
    currentYear: number | null;
    graduationYear: number | null;
    portfolioUrl: string | null;
    linkedinUrl: string | null;
    githubProfileUrl: string | null;
    otherSocialUrls: any;
    isOpenToOpportunities: boolean;
    isOnline?: boolean;
    lastActiveAt?: Date | null;
    verified: boolean;
    interests: string[];
    profileRing?: string | null;
    visitLoaderGiftId?: string | null;
    createdAt: Date;
  };
  stats: {
    xp: number;
    level: number;
    xpToNextLevel: number;
    totalPosts: number;
    totalArticles: number;
    totalShortVideos: number;
    totalForumQuestions: number;
    totalForumAnswers: number;
    totalComments: number;
    totalLikesReceived: number;
    connectionsCount: number;
    followersCount: number;
    currentStreak: number;
    longestStreak: number;
    lastActiveDate: Date | null;
    totalActiveDays: number;
  };
  github: {
    connected: boolean;
    username: string | null;
    avatarUrl: string | null;
    profileUrl: string | null;
    stats: {
      totalPublicRepos: number;
      totalStars: number;
      totalForks: number;
      followers: number;
      following: number;
      topLanguages: any[];
      topRepos: any[];
    } | null;
    contributionCalendar: any | null;
    lastSyncedAt: Date | null;
  };
  activityHeatmap: any[]; // Array of ActivityHeatmapDay (for backward compatibility, full response available via /activity endpoint)
  recentActivity: UnifiedFeedResponse;
  skills: Array<{
    id: string;
    skill: {
      id: string;
      name: string;
      category: string | null;
    };
    proficiency: string | null;
    yearsOfExp: number | null;
  }>;
  experiences: any[];
  education: any[];
  projects: any[];
  certificates: any[];
  achievements: any[];
}
