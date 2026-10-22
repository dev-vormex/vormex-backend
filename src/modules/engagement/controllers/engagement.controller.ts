/** Stable import surface; implementations are grouped by responsibility. */
export { dailyMatchSnapshotWindow } from './engagement/snapshot-support.controller';
export {
  getStreaks,
  recordLogin,
  getStreakHistory,
  getPublicStreaks,
  purchaseStreakFreeze,
  toggleStreakShield,
  getStreakLeaderboard,
  toggleStreakVisibility,
} from './engagement/streaks.controller';
export { getRewardCards, postRewardEvent } from './engagement/rewards.controller';
export { getDailyMatches, getPeopleLikeYou, getHiddenGem } from './engagement/matches.controller';
export { getTrendingStatus, getLiveActivity, getRecentJoins } from './engagement/activity.controller';
export { getLeaderboard } from './engagement/leaderboard.controller';
export { getNudges, getWeeklyGoals } from './engagement/goals.controller';
export {
  getConnectionLimit,
  getSessionSummary,
  getConnectionCelebration,
  getDashboard,
} from './engagement/session.controller';
