/** Stable import surface; implementations live in focused responsibility modules. */
export { recordActivity } from './activity/record-activity.service';
export { calculateStreak, updateUserStats } from './activity/calculate-streak.service';
export { getContributionYears, getActivityHeatmap } from './activity/get-contribution-years.service';
