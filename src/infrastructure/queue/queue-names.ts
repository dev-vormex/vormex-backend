export const queueNames = {
  realtimeFanout: 'realtime_fanout',
  notificationDelivery: 'notification_delivery',
  cacheInvalidation: 'cache_invalidation',
  analyticsEvents: 'analytics_events',
  mediaProcessing: 'media_processing',
  scheduledPublish: 'scheduled_publish',
  peopleYouKnow: 'people_you_know',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];
