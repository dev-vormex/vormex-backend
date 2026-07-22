CREATE TABLE "recommendation_events" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "requestId" TEXT,
  "recommendationSessionId" TEXT,
  "reportedPosition" INTEGER,
  "position" INTEGER,
  "maxVisibleFraction" DOUBLE PRECISION,
  "visibleTimeMs" INTEGER,
  "playbackTimeMs" INTEGER,
  "mediaDurationMs" INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "qualifiedExposure" BOOLEAN NOT NULL DEFAULT false,
  "cascadeEngagement" BOOLEAN NOT NULL DEFAULT false,
  "qualifiedPositive" BOOLEAN NOT NULL DEFAULT false,
  "meaningfulOutcome" BOOLEAN NOT NULL DEFAULT false,
  "isBoosted" BOOLEAN NOT NULL DEFAULT false,
  "rankerVersion" TEXT,
  "experimentVariant" TEXT,
  "examinationPropensity" DOUBLE PRECISION,
  "metadata" JSONB,
  CONSTRAINT "recommendation_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_events_eventId_key" ON "recommendation_events"("eventId");
CREATE INDEX "recommendation_events_user_occurred_idx" ON "recommendation_events"("userId", "occurredAt");
CREATE INDEX "recommendation_events_session_entity_idx" ON "recommendation_events"("recommendationSessionId", "entityType", "entityId");
CREATE INDEX "recommendation_events_surface_type_time_idx" ON "recommendation_events"("surface", "eventType", "occurredAt");
CREATE INDEX "recommendation_events_entity_time_idx" ON "recommendation_events"("entityType", "entityId", "occurredAt");
CREATE INDEX "recommendation_events_training_idx" ON "recommendation_events"("qualifiedExposure", "isBoosted", "occurredAt");
CREATE UNIQUE INDEX "recommendation_events_qualified_exposure_once"
  ON "recommendation_events"("userId", "recommendationSessionId", "entityType", "entityId")
  WHERE "qualifiedExposure" = true;

CREATE TABLE "recommendation_feedback" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "authorId" TEXT,
  "feedbackType" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recommendation_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_feedback_user_entity_type_key"
  ON "recommendation_feedback"("userId", "entityType", "entityId", "feedbackType");
CREATE INDEX "recommendation_feedback_user_active_idx" ON "recommendation_feedback"("userId", "isActive", "updatedAt");
CREATE INDEX "recommendation_feedback_author_active_idx" ON "recommendation_feedback"("userId", "authorId", "isActive");

CREATE TABLE "recommendation_user_profiles" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "personalizedRecommendationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "activityRecommendationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "interactionCount" INTEGER NOT NULL DEFAULT 0,
  "positiveVector" vector(1536),
  "negativeVector" vector(1536),
  "vectorContentHash" TEXT,
  "vectorUpdatedAt" TIMESTAMP(3),
  "featureState" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recommendation_user_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_user_profiles_userId_key" ON "recommendation_user_profiles"("userId");
CREATE INDEX "recommendation_user_profiles_vector_updated_idx" ON "recommendation_user_profiles"("vectorUpdatedAt");

CREATE TABLE "recommendation_item_daily_stats" (
  "id" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "surface" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "organicImpressions" INTEGER NOT NULL DEFAULT 0,
  "organicCascadeEngagements" INTEGER NOT NULL DEFAULT 0,
  "organicQualifiedPositives" INTEGER NOT NULL DEFAULT 0,
  "organicMeaningfulOutcomes" INTEGER NOT NULL DEFAULT 0,
  "organicNegativeFeedback" INTEGER NOT NULL DEFAULT 0,
  "boostedImpressions" INTEGER NOT NULL DEFAULT 0,
  "boostedClicks" INTEGER NOT NULL DEFAULT 0,
  "boostedMeaningfulOutcomes" INTEGER NOT NULL DEFAULT 0,
  "trailingEngagementAlpha" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "trailingEngagementBeta" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "independentReactors" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recommendation_item_daily_stats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_item_daily_stats_key" ON "recommendation_item_daily_stats"("day", "surface", "entityType", "entityId");
CREATE INDEX "recommendation_item_daily_stats_surface_day_idx" ON "recommendation_item_daily_stats"("surface", "day");
CREATE INDEX "recommendation_item_daily_stats_entity_day_idx" ON "recommendation_item_daily_stats"("entityType", "entityId", "day");

CREATE TABLE "recommendation_models" (
  "id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "head" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'shadow',
  "featureSchema" JSONB NOT NULL,
  "coefficients" JSONB NOT NULL,
  "priors" JSONB NOT NULL,
  "thresholds" JSONB NOT NULL,
  "trainingImpressions" INTEGER NOT NULL DEFAULT 0,
  "positiveLabels" INTEGER NOT NULL DEFAULT 0,
  "trainedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recommendation_models_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_models_surface_head_version_key" ON "recommendation_models"("surface", "head", "version");
CREATE INDEX "recommendation_models_status_idx" ON "recommendation_models"("surface", "head", "status", "createdAt");

-- Versioned surface priors and floors. Learned heads are inserted separately in shadow status.
INSERT INTO "recommendation_models"
  ("id", "surface", "head", "version", "status", "featureSchema", "coefficients", "priors", "thresholds", "updatedAt")
SELECT
  'heuristic-' || lower(surface) || '-vormex-unified-v1', surface, 'heuristic', 'vormex-unified-v1', 'active',
  '{"names":["semantic","relationship","socialProof","quality","freshness","exploration","cohortFit"],"missing":"surface_mean_imputation"}'::jsonb,
  '{"semantic":0.28,"relationship":0.22,"socialProof":0.16,"quality":0.14,"freshness":0.10,"exploration":0.05,"cohortFit":0.05}'::jsonb,
  CASE surface
    WHEN 'HOME' THEN '{"semantic":0.35,"relationship":0.25,"socialProof":0.20,"quality":0.50,"freshness":0.50,"exploration":0.50,"cohortFit":0.30}'::jsonb
    WHEN 'REELS' THEN '{"semantic":0.40,"relationship":0.20,"socialProof":0.30,"quality":0.50,"freshness":0.55,"exploration":0.50,"cohortFit":0.25}'::jsonb
    ELSE '{"semantic":0.35,"relationship":0.25,"socialProof":0.20,"quality":0.50,"freshness":0.50,"exploration":0.50,"cohortFit":0.30}'::jsonb
  END,
  '{"relevance":"positive_retrieval_source","negativeRateMaximum":0.03,"negativeRateMinimumOrganicImpressions":100}'::jsonb,
  CURRENT_TIMESTAMP
FROM unnest(ARRAY['HOME','REELS','STORIES','PEOPLE','JOBS','EVENTS']) AS surface;

CREATE TABLE "recommendation_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "snapshotAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "validationUntil" TIMESTAMP(3) NOT NULL,
  "rankerVersion" TEXT NOT NULL,
  "experimentVariant" TEXT NOT NULL,
  "orderedItems" JSONB NOT NULL,
  "modulePlacements" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_sessions_requestId_key" ON "recommendation_sessions"("requestId");
CREATE INDEX "recommendation_sessions_user_surface_idx" ON "recommendation_sessions"("userId", "surface", "createdAt");
CREATE INDEX "recommendation_sessions_expires_idx" ON "recommendation_sessions"("expiresAt");
CREATE INDEX "recommendation_sessions_validation_idx" ON "recommendation_sessions"("validationUntil");

CREATE TABLE "recommendation_cascade_states" (
  "id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "wave" INTEGER NOT NULL DEFAULT 0,
  "qualifiedImpressions" INTEGER NOT NULL DEFAULT 0,
  "cascadeEngagements" INTEGER NOT NULL DEFAULT 0,
  "meaningfulOutcomes" INTEGER NOT NULL DEFAULT 0,
  "independentReactors" INTEGER NOT NULL DEFAULT 0,
  "releasedViewerCount" INTEGER NOT NULL DEFAULT 0,
  "trailingWeightedSuccesses" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "trailingWeightedFailures" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "lastImpressionSequence" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'active',
  "stopReason" TEXT,
  "lastEvaluatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recommendation_cascade_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_cascade_states_entity_key" ON "recommendation_cascade_states"("surface", "entityType", "entityId");
CREATE INDEX "recommendation_cascade_states_status_idx" ON "recommendation_cascade_states"("status", "updatedAt");

CREATE TABLE "recommendation_cascade_deliveries" (
  "id" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "sourceActorId" TEXT,
  "wave" INTEGER NOT NULL,
  "batch" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_cascade_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "recommendation_cascade_deliveries_entity_viewer_key"
  ON "recommendation_cascade_deliveries"("surface", "entityType", "entityId", "viewerId");
CREATE INDEX "recommendation_cascade_deliveries_viewer_surface_idx"
  ON "recommendation_cascade_deliveries"("viewerId", "surface", "createdAt");
CREATE INDEX "recommendation_cascade_deliveries_entity_wave_idx"
  ON "recommendation_cascade_deliveries"("surface", "entityType", "entityId", "wave");
CREATE INDEX "recommendation_cascade_deliveries_actor_idx"
  ON "recommendation_cascade_deliveries"("sourceActorId", "createdAt");

CREATE TABLE "premium_boost_credit_windows" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "entitlementKey" TEXT NOT NULL,
  "windowStartsAt" TIMESTAMP(3) NOT NULL,
  "windowEndsAt" TIMESTAMP(3) NOT NULL,
  "creditsGranted" INTEGER NOT NULL DEFAULT 2,
  "creditsConsumed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "premium_boost_credit_windows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "premium_boost_credit_windows_entitlement_key" ON "premium_boost_credit_windows"("userId", "entitlementKey");
CREATE INDEX "premium_boost_credit_windows_user_end_idx" ON "premium_boost_credit_windows"("userId", "windowEndsAt");

CREATE TABLE "premium_post_boost_campaigns" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "creditWindowId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "targeting" JSONB,
  "impressionsCount" INTEGER NOT NULL DEFAULT 0,
  "clicksCount" INTEGER NOT NULL DEFAULT 0,
  "meaningfulActionsCount" INTEGER NOT NULL DEFAULT 0,
  "negativeFeedbackCount" INTEGER NOT NULL DEFAULT 0,
  "pauseReason" TEXT,
  "deliveredFirstImpressionAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "premium_post_boost_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "premium_post_boost_campaigns_user_status_idx" ON "premium_post_boost_campaigns"("userId", "status", "endsAt");
CREATE INDEX "premium_post_boost_campaigns_post_status_idx" ON "premium_post_boost_campaigns"("postId", "status", "endsAt");
CREATE INDEX "premium_post_boost_campaigns_delivery_idx" ON "premium_post_boost_campaigns"("status", "startsAt", "endsAt");
CREATE UNIQUE INDEX "premium_post_boost_campaigns_one_active_user" ON "premium_post_boost_campaigns"("userId") WHERE "status" = 'active';
CREATE UNIQUE INDEX "premium_post_boost_campaigns_one_active_post" ON "premium_post_boost_campaigns"("postId") WHERE "status" = 'active';

ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_feedback" ADD CONSTRAINT "recommendation_feedback_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_user_profiles" ADD CONSTRAINT "recommendation_user_profiles_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_sessions" ADD CONSTRAINT "recommendation_sessions_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_cascade_deliveries" ADD CONSTRAINT "recommendation_cascade_deliveries_viewer_fkey"
  FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_cascade_deliveries" ADD CONSTRAINT "recommendation_cascade_deliveries_actor_fkey"
  FOREIGN KEY ("sourceActorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "premium_boost_credit_windows" ADD CONSTRAINT "premium_boost_credit_windows_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "premium_post_boost_campaigns" ADD CONSTRAINT "premium_post_boost_campaigns_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "premium_post_boost_campaigns" ADD CONSTRAINT "premium_post_boost_campaigns_post_fkey"
  FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "premium_post_boost_campaigns" ADD CONSTRAINT "premium_post_boost_campaigns_credit_window_fkey"
  FOREIGN KEY ("creditWindowId") REFERENCES "premium_boost_credit_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "feature_flags" ("id", "key", "name", "description", "requiredPlan", "isEnabled", "createdAt", "updatedAt")
VALUES
  ('recommendation-events-v1', 'recommendation_events_v1', 'Recommendation events', 'Trustworthy viewport and interaction telemetry', 'free', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('recommendation-semantic-v1', 'recommendation_semantic_v1', 'Semantic recommendations', 'Cached-vector semantic retrieval', 'free', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('recommendation-shadow-v1', 'recommendation_shadow_v1', 'Shadow ranker', 'Run the unified ranker without serving its order', 'free', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('recommendation-treatment-v1', 'recommendation_treatment_v1', 'Unified ranker treatment', 'Serve backend-owned unified recommendation order', 'free', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('recommendation-position-v1', 'recommendation_position_exploration_v1', 'Position exploration', 'Constrained position swaps for propensity estimation', 'free', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('premium-post-boost-v1', 'premium_post_boost_v1', 'Premium post boosts', 'Two Premium post boost credits per entitlement window', 'premium', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
