-- Restore schema models missing from the historical migration chain.
-- Additive only: no existing tables, columns, or records are removed.

-- CreateTable
CREATE TABLE "accountability_pairs" (
    "id" TEXT NOT NULL,
    "user1Id" TEXT NOT NULL,
    "user2Id" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "sharedStreak" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastCheckIn" TIMESTAMP(3),
    "checkInsCompleted" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),

    CONSTRAINT "accountability_pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_challenges" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "xpReward" INTEGER NOT NULL DEFAULT 50,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "participantsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circle_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_members" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "xpInCircle" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circle_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circle_posts" (
    "id" TEXT NOT NULL,
    "circleId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'discussion',
    "mediaUrls" TEXT[],
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circle_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "circles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "coverImageUrl" TEXT,
    "emoji" TEXT,
    "category" TEXT NOT NULL,
    "campus" TEXT,
    "tags" TEXT[],
    "type" TEXT NOT NULL DEFAULT 'interest',
    "isAutoCreated" BOOLEAN NOT NULL DEFAULT false,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "maxMembers" INTEGER NOT NULL DEFAULT 500,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "activeMembers" INTEGER NOT NULL DEFAULT 0,
    "postsCount" INTEGER NOT NULL DEFAULT 0,
    "weeklyActivity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requiredPlan" TEXT NOT NULL DEFAULT 'free',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentorship_matches" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "menteeId" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sessionsCompleted" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION,
    "feedback" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "mentorship_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "primaryGoal" TEXT,
    "skillLevel" TEXT,
    "skillsToLearn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skillsToTeach" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailySchedule" TEXT,
    "lookingFor" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "campus" TEXT,
    "year" INTEGER,
    "branch" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "completenessScore" INTEGER NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_views" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "razorpaySubscriptionId" TEXT,
    "razorpayCustomerId" TEXT,
    "razorpayPlanId" TEXT,
    "googlePlayPurchaseToken" TEXT,
    "googlePlayOrderId" TEXT,
    "googlePlayProductId" TEXT,
    "googlePlayBasePlanId" TEXT,
    "googlePlaySubscriptionState" TEXT,
    "googlePlayAcknowledgementState" TEXT,
    "lastProviderSyncAt" TIMESTAMP(3),
    "amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "billingCycle" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accountability_pairs_user1Id_idx" ON "accountability_pairs"("user1Id");

-- CreateIndex
CREATE INDEX "accountability_pairs_user2Id_idx" ON "accountability_pairs"("user2Id");

-- CreateIndex
CREATE UNIQUE INDEX "accountability_pairs_user1Id_user2Id_key" ON "accountability_pairs"("user1Id", "user2Id");

-- CreateIndex
CREATE INDEX "circle_challenges_circleId_idx" ON "circle_challenges"("circleId");

-- CreateIndex
CREATE INDEX "circle_challenges_isActive_idx" ON "circle_challenges"("isActive");

-- CreateIndex
CREATE INDEX "circle_members_circleId_idx" ON "circle_members"("circleId");

-- CreateIndex
CREATE INDEX "circle_members_userId_idx" ON "circle_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "circle_members_circleId_userId_key" ON "circle_members"("circleId", "userId");

-- CreateIndex
CREATE INDEX "circle_posts_authorId_idx" ON "circle_posts"("authorId");

-- CreateIndex
CREATE INDEX "circle_posts_circleId_createdAt_idx" ON "circle_posts"("circleId", "createdAt");

-- CreateIndex
CREATE INDEX "circle_posts_circleId_idx" ON "circle_posts"("circleId");

-- CreateIndex
CREATE UNIQUE INDEX "circles_slug_key" ON "circles"("slug");

-- CreateIndex
CREATE INDEX "circles_campus_idx" ON "circles"("campus");

-- CreateIndex
CREATE INDEX "circles_category_idx" ON "circles"("category");

-- CreateIndex
CREATE INDEX "circles_memberCount_idx" ON "circles"("memberCount");

-- CreateIndex
CREATE INDEX "circles_slug_idx" ON "circles"("slug");

-- CreateIndex
CREATE INDEX "circles_type_idx" ON "circles"("type");

-- CreateIndex
CREATE INDEX "coin_transactions_userId_createdAt_idx" ON "coin_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "coin_transactions_userId_idx" ON "coin_transactions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE INDEX "feature_flags_key_idx" ON "feature_flags"("key");

-- CreateIndex
CREATE INDEX "mentorship_matches_menteeId_idx" ON "mentorship_matches"("menteeId");

-- CreateIndex
CREATE INDEX "mentorship_matches_mentorId_idx" ON "mentorship_matches"("mentorId");

-- CreateIndex
CREATE UNIQUE INDEX "mentorship_matches_mentorId_menteeId_skill_key" ON "mentorship_matches"("mentorId", "menteeId", "skill");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_profiles_userId_key" ON "onboarding_profiles"("userId");

-- CreateIndex
CREATE INDEX "onboarding_profiles_isCompleted_idx" ON "onboarding_profiles"("isCompleted");

-- CreateIndex
CREATE INDEX "onboarding_profiles_userId_idx" ON "onboarding_profiles"("userId");

-- CreateIndex
CREATE INDEX "onboarding_profiles_primaryGoal_idx" ON "onboarding_profiles"("primaryGoal");

-- CreateIndex
CREATE INDEX "story_views_storyId_idx" ON "story_views"("storyId");

-- CreateIndex
CREATE INDEX "story_views_viewerId_idx" ON "story_views"("viewerId");

-- CreateIndex
CREATE INDEX "story_views_viewedAt_idx" ON "story_views"("viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "story_views_storyId_viewerId_key" ON "story_views"("storyId", "viewerId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_googlePlayPurchaseToken_key" ON "subscriptions"("googlePlayPurchaseToken");

-- CreateIndex
CREATE INDEX "subscriptions_plan_idx" ON "subscriptions"("plan");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_provider_idx" ON "subscriptions"("provider");

-- CreateIndex
CREATE INDEX "subscriptions_userId_idx" ON "subscriptions"("userId");

-- CreateIndex
CREATE INDEX "subscriptions_googlePlayProductId_idx" ON "subscriptions"("googlePlayProductId");

-- CreateIndex
CREATE INDEX "subscriptions_googlePlayBasePlanId_idx" ON "subscriptions"("googlePlayBasePlanId");

-- AddForeignKey
ALTER TABLE "accountability_pairs" ADD CONSTRAINT "accountability_pairs_user1Id_fkey" FOREIGN KEY ("user1Id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accountability_pairs" ADD CONSTRAINT "accountability_pairs_user2Id_fkey" FOREIGN KEY ("user2Id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_challenges" ADD CONSTRAINT "circle_challenges_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_members" ADD CONSTRAINT "circle_members_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_members" ADD CONSTRAINT "circle_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circle_posts" ADD CONSTRAINT "circle_posts_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "circles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_matches" ADD CONSTRAINT "mentorship_matches_menteeId_fkey" FOREIGN KEY ("menteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentorship_matches" ADD CONSTRAINT "mentorship_matches_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_profiles" ADD CONSTRAINT "onboarding_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
