import { engagementService } from '../modules/engagement/services/engagement.service';
import { importExternalHackathons } from '../modules/opportunities/services/hackathon-import.service';
import { runHackathonWeeklyDigest } from '../modules/opportunities/services/hackathon-digest.service';
import { runReengagementCampaign } from '../modules/notifications/services/reengagement-notification.service';
import { socialProofService } from '../modules/profiles/services/social-proof.service';
import { storyService } from '../modules/content/services/story.service';
import { runSavedDiscoverySearchDigest } from '../modules/discovery/services/discovery-power.service';
import { runHighQualityMatchDigest } from '../modules/notifications/services/match-availability-notification.service';
import { aggregateRecommendationEvents, seedSocialCascadeAudiences, trainRecommendationModels, updateCascadeStates } from '../modules/discovery/services/recommendation-learning.service';
import { reindexRecommendationDocuments } from '../modules/discovery/services/recommendation-embedding.service';
import { cleanupRecommendationData } from '../modules/discovery/services/recommendation-platform.service';
import { maintainPostBoostCampaigns } from '../modules/premium/services/premium-post-boost.service';

export const maintenanceSchedules = [
  {
    schedulerId: 'recommendation_event_aggregation',
    jobName: 'recommendation_event_aggregation',
    pattern: '*/15 * * * *',
  },
  {
    schedulerId: 'recommendation_embedding_reindex',
    jobName: 'recommendation_embedding_reindex',
    pattern: '7 */1 * * *',
  },
  {
    schedulerId: 'recommendation_model_training',
    jobName: 'recommendation_model_training',
    pattern: '30 20 * * *',
  },
  {
    schedulerId: 'recommendation_data_cleanup',
    jobName: 'recommendation_data_cleanup',
    pattern: '15 21 * * *',
  },
  {
    schedulerId: 'reengagement_campaign_hourly',
    jobName: 'reengagement_campaign_hourly',
    pattern: '30 * * * *',
  },
  {
    schedulerId: 'streak_freeze_processing',
    jobName: 'streak_freeze_processing',
    pattern: '0 19 * * *',
  },
  {
    schedulerId: 'weekly_counter_reset',
    jobName: 'weekly_counter_reset',
    pattern: '30 18 * * 0',
  },
  {
    schedulerId: 'hackathon_weekly_digest',
    jobName: 'hackathon_weekly_digest',
    pattern: '0 17 * * 5',
  },
  {
    schedulerId: 'hackathon_external_import',
    jobName: 'hackathon_external_import',
    pattern: '15 */6 * * *',
  },
  {
    schedulerId: 'saved_discovery_search_digest',
    jobName: 'saved_discovery_search_digest',
    pattern: '45 18 * * *',
  },
  {
    schedulerId: 'daily_high_quality_match_digest',
    jobName: 'daily_high_quality_match_digest',
    pattern: '15 18 * * *',
  },
  {
    schedulerId: 'social_proof_leaderboard',
    jobName: 'social_proof_leaderboard',
    pattern: '0 * * * *',
  },
  {
    schedulerId: 'social_proof_trending',
    jobName: 'social_proof_trending',
    pattern: '*/15 * * * *',
  },
  {
    schedulerId: 'social_proof_cleanup',
    jobName: 'social_proof_cleanup',
    pattern: '30 19 * * *',
  },
  {
    schedulerId: 'story_cleanup',
    jobName: 'story_cleanup',
    pattern: '0 * * * *',
  },
  {
    schedulerId: 'study_streak_calculation',
    jobName: 'study_streak_calculation',
    pattern: '30 18 * * *',
  },
  {
    schedulerId: 'story_interactive_notifications',
    jobName: 'story_interactive_notifications',
    pattern: '*/5 * * * *',
  },
  {
    schedulerId: 'story_countdown_notifications',
    jobName: 'story_countdown_notifications',
    pattern: '* * * * *',
  },
] as const;

export type MaintenanceJobName = (typeof maintenanceSchedules)[number]['jobName'];

export async function runMaintenanceJob(jobName: MaintenanceJobName): Promise<unknown> {
  switch (jobName) {
    case 'recommendation_event_aggregation':
      await aggregateRecommendationEvents();
      return {
        socialCascade: await seedSocialCascadeAudiences(),
        cascade: await updateCascadeStates(),
        boosts: await maintainPostBoostCampaigns(),
      };
    case 'recommendation_embedding_reindex':
      return reindexRecommendationDocuments();
    case 'recommendation_model_training':
      if (process.env.RECOMMENDATION_SHADOW_MODEL_ENABLED !== 'true') {
        return { skipped: true, reason: 'recommendation_shadow_model_disabled' };
      }
      return trainRecommendationModels();
    case 'recommendation_data_cleanup':
      return cleanupRecommendationData();
    case 'reengagement_campaign_hourly':
      return runReengagementCampaign();
    case 'streak_freeze_processing':
      return engagementService.processStreakFreezes();
    case 'weekly_counter_reset':
      return engagementService.resetWeeklyCounters();
    case 'hackathon_weekly_digest':
      return runHackathonWeeklyDigest();
    case 'hackathon_external_import':
      return importExternalHackathons();
    case 'saved_discovery_search_digest':
      return runSavedDiscoverySearchDigest();
    case 'daily_high_quality_match_digest':
      return runHighQualityMatchDigest();
    case 'social_proof_leaderboard':
      return socialProofService.runLeaderboardCron();
    case 'social_proof_trending':
      return socialProofService.runTrendingCron();
    case 'social_proof_cleanup':
      await socialProofService.cleanupOldActivities();
      await socialProofService.cleanupOldProfileViews();
      return socialProofService.runOnboardingCron();
    case 'story_cleanup':
      return storyService.cleanupExpiredStories();
    case 'study_streak_calculation':
      return storyService.calculateStudyStreaks();
    case 'story_interactive_notifications':
      return storyService.processInteractiveNotifications();
    case 'story_countdown_notifications':
      return storyService.processCountdownNotifications();
    default: {
      const exhaustiveCheck: never = jobName;
      return exhaustiveCheck;
    }
  }
}
