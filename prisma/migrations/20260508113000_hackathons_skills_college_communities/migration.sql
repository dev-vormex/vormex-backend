CREATE TABLE "skill_verification_links" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "profileUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'verified',
  "metadata" JSONB,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "skill_verification_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hackathons" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "organizer" TEXT,
  "source" TEXT NOT NULL DEFAULT 'college_fest',
  "sourceUrl" TEXT,
  "sourceId" TEXT,
  "college" TEXT,
  "description" TEXT NOT NULL,
  "theme" TEXT,
  "location" TEXT,
  "isOnline" BOOLEAN NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "registrationDeadline" TIMESTAMP(3),
  "teamMin" INTEGER NOT NULL DEFAULT 1,
  "teamMax" INTEGER NOT NULL DEFAULT 4,
  "prizeSummary" TEXT,
  "tags" TEXT[],
  "skills" TEXT[],
  "bannerUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "hackathons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hackathon_teams" (
  "id" TEXT NOT NULL,
  "hackathonId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "groupId" TEXT,
  "name" TEXT NOT NULL,
  "pitch" TEXT,
  "lookingForRoles" TEXT[],
  "requiredSkills" TEXT[],
  "maxMembers" INTEGER NOT NULL DEFAULT 4,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "hackathon_teams_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hackathon_team_members" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "status" TEXT NOT NULL DEFAULT 'accepted',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hackathon_team_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hackathon_team_applications" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "applicantId" TEXT NOT NULL,
  "role" TEXT,
  "message" TEXT,
  "skills" TEXT[],
  "status" TEXT NOT NULL DEFAULT 'pending',
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "hackathon_team_applications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hackathon_saves" (
  "id" TEXT NOT NULL,
  "hackathonId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hackathon_saves_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "college_communities" (
  "id" TEXT NOT NULL,
  "college" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "groupId" TEXT NOT NULL,
  "emailDomains" TEXT[],
  "verificationMode" TEXT NOT NULL DEFAULT 'profile_college',
  "memberCount" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "college_communities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "college_community_members" (
  "id" TEXT NOT NULL,
  "communityId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "college_community_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "college_student_verifications" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "college" TEXT NOT NULL,
  "studentEmail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'verified',
  "method" TEXT NOT NULL DEFAULT 'profile_college',
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "college_student_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skill_verification_links_userId_provider_key" ON "skill_verification_links"("userId", "provider");
CREATE INDEX "skill_verification_links_userId_status_idx" ON "skill_verification_links"("userId", "status");
CREATE INDEX "skill_verification_links_provider_username_idx" ON "skill_verification_links"("provider", "username");

CREATE UNIQUE INDEX "hackathons_slug_key" ON "hackathons"("slug");
CREATE UNIQUE INDEX "hackathons_source_sourceId_key" ON "hackathons"("source", "sourceId");
CREATE INDEX "hackathons_status_startsAt_idx" ON "hackathons"("status", "startsAt");
CREATE INDEX "hackathons_source_startsAt_idx" ON "hackathons"("source", "startsAt");
CREATE INDEX "hackathons_college_startsAt_idx" ON "hackathons"("college", "startsAt");
CREATE INDEX "hackathons_isActive_startsAt_idx" ON "hackathons"("isActive", "startsAt");
CREATE INDEX "hackathons_createdAt_idx" ON "hackathons"("createdAt");

CREATE INDEX "hackathon_teams_hackathonId_status_idx" ON "hackathon_teams"("hackathonId", "status");
CREATE INDEX "hackathon_teams_ownerId_createdAt_idx" ON "hackathon_teams"("ownerId", "createdAt");
CREATE INDEX "hackathon_teams_groupId_idx" ON "hackathon_teams"("groupId");

CREATE UNIQUE INDEX "hackathon_team_members_teamId_userId_key" ON "hackathon_team_members"("teamId", "userId");
CREATE INDEX "hackathon_team_members_teamId_status_idx" ON "hackathon_team_members"("teamId", "status");
CREATE INDEX "hackathon_team_members_userId_joinedAt_idx" ON "hackathon_team_members"("userId", "joinedAt");

CREATE UNIQUE INDEX "hackathon_team_applications_teamId_applicantId_key" ON "hackathon_team_applications"("teamId", "applicantId");
CREATE INDEX "hackathon_team_applications_applicantId_status_createdAt_idx" ON "hackathon_team_applications"("applicantId", "status", "createdAt");
CREATE INDEX "hackathon_team_applications_teamId_status_createdAt_idx" ON "hackathon_team_applications"("teamId", "status", "createdAt");

CREATE UNIQUE INDEX "hackathon_saves_hackathonId_userId_key" ON "hackathon_saves"("hackathonId", "userId");
CREATE INDEX "hackathon_saves_userId_createdAt_idx" ON "hackathon_saves"("userId", "createdAt");
CREATE INDEX "hackathon_saves_hackathonId_idx" ON "hackathon_saves"("hackathonId");

CREATE UNIQUE INDEX "college_communities_slug_key" ON "college_communities"("slug");
CREATE UNIQUE INDEX "college_communities_groupId_key" ON "college_communities"("groupId");
CREATE INDEX "college_communities_college_idx" ON "college_communities"("college");
CREATE INDEX "college_communities_memberCount_idx" ON "college_communities"("memberCount");

CREATE UNIQUE INDEX "college_community_members_communityId_userId_key" ON "college_community_members"("communityId", "userId");
CREATE INDEX "college_community_members_userId_joinedAt_idx" ON "college_community_members"("userId", "joinedAt");
CREATE INDEX "college_community_members_communityId_idx" ON "college_community_members"("communityId");

CREATE UNIQUE INDEX "college_student_verifications_userId_college_key" ON "college_student_verifications"("userId", "college");
CREATE INDEX "college_student_verifications_college_status_idx" ON "college_student_verifications"("college", "status");
CREATE INDEX "college_student_verifications_userId_status_idx" ON "college_student_verifications"("userId", "status");

ALTER TABLE "hackathon_teams"
  ADD CONSTRAINT "hackathon_teams_hackathonId_fkey"
  FOREIGN KEY ("hackathonId") REFERENCES "hackathons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hackathon_team_members"
  ADD CONSTRAINT "hackathon_team_members_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "hackathon_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hackathon_team_applications"
  ADD CONSTRAINT "hackathon_team_applications_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "hackathon_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "hackathon_saves"
  ADD CONSTRAINT "hackathon_saves_hackathonId_fkey"
  FOREIGN KEY ("hackathonId") REFERENCES "hackathons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "college_community_members"
  ADD CONSTRAINT "college_community_members_communityId_fkey"
  FOREIGN KEY ("communityId") REFERENCES "college_communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
