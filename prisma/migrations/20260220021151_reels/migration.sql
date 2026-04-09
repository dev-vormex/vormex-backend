-- CreateEnum
CREATE TYPE "TriviaCategory" AS ENUM ('TECH', 'PROGRAMMING', 'WEB_DEV', 'MOBILE_DEV', 'AI_ML', 'DATA_SCIENCE', 'CYBERSECURITY', 'DEVOPS', 'GENERAL');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD', 'EXPERT');

-- CreateEnum
CREATE TYPE "CodingCategory" AS ENUM ('ARRAYS', 'STRINGS', 'LINKED_LISTS', 'TREES', 'GRAPHS', 'DYNAMIC_PROGRAMMING', 'SORTING', 'SEARCHING', 'RECURSION', 'MATH', 'OTHER');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "adminTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "adminTwoFactorSecret" TEXT,
ADD COLUMN     "currentCity" TEXT,
ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isBanned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isOnline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "xpBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_views" (
    "id" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "viewedId" TEXT NOT NULL,
    "source" TEXT,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_streaks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionStreak" INTEGER NOT NULL DEFAULT 0,
    "loginStreak" INTEGER NOT NULL DEFAULT 0,
    "postingStreak" INTEGER NOT NULL DEFAULT 0,
    "messagingStreak" INTEGER NOT NULL DEFAULT 0,
    "lastConnectionDate" TIMESTAMP(3),
    "lastLoginDate" TIMESTAMP(3),
    "lastPostDate" TIMESTAMP(3),
    "lastMessageDate" TIMESTAMP(3),
    "streakFreezes" INTEGER NOT NULL DEFAULT 0,
    "streakShieldActive" BOOLEAN NOT NULL DEFAULT false,
    "bestConnectionStreak" INTEGER NOT NULL DEFAULT 0,
    "bestLoginStreak" INTEGER NOT NULL DEFAULT 0,
    "bestPostingStreak" INTEGER NOT NULL DEFAULT 0,
    "bestMessagingStreak" INTEGER NOT NULL DEFAULT 0,
    "longestConnectionStreak" INTEGER NOT NULL DEFAULT 0,
    "longestLoginStreak" INTEGER NOT NULL DEFAULT 0,
    "longestPostingStreak" INTEGER NOT NULL DEFAULT 0,
    "longestMessagingStreak" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_streaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_proof_leaderboards" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "userName" TEXT,
    "userImage" TEXT,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_proof_leaderboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mediaUrls" TEXT[],
    "type" TEXT NOT NULL DEFAULT 'text',
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "sharesCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_likes" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_comments" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_likes" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_posts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "iconImage" TEXT,
    "coverImage" TEXT,
    "creatorId" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "memberCount" INTEGER NOT NULL DEFAULT 1,
    "maxMembers" INTEGER NOT NULL DEFAULT 50,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_messages" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "replyToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_message_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_stats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalXpEarned" INTEGER NOT NULL DEFAULT 0,
    "totalGamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastPlayedAt" TIMESTAMP(3),
    "triviaGamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "triviaCorrectAnswers" INTEGER NOT NULL DEFAULT 0,
    "triviaTotalQuestions" INTEGER NOT NULL DEFAULT 0,
    "codingProblemsAttempted" INTEGER NOT NULL DEFAULT 0,
    "codingProblemsSolved" INTEGER NOT NULL DEFAULT 0,
    "codingTotalSubmissions" INTEGER NOT NULL DEFAULT 0,
    "wordleGamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wordleGamesWon" INTEGER NOT NULL DEFAULT 0,
    "wordleCurrentStreak" INTEGER NOT NULL DEFAULT 0,
    "wordleBestStreak" INTEGER NOT NULL DEFAULT 0,
    "wordleAverageAttempts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "typingGamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "typingBestWpm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "typingAverageWpm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "typingBestAccuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quizBattlesPlayed" INTEGER NOT NULL DEFAULT 0,
    "quizBattlesWon" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xp_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trivia_questions" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctIndex" INTEGER NOT NULL,
    "explanation" TEXT,
    "category" "TriviaCategory" NOT NULL DEFAULT 'GENERAL',
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "xpReward" INTEGER NOT NULL DEFAULT 10,
    "timeLimit" INTEGER NOT NULL DEFAULT 30,
    "imageUrl" TEXT,
    "timesPlayed" INTEGER NOT NULL DEFAULT 0,
    "timesCorrect" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trivia_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_trivia_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "questionsIds" JSONB NOT NULL,
    "totalQuestions" INTEGER NOT NULL DEFAULT 5,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "totalXpEarned" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "daily_trivia_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trivia_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedIndex" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trivia_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coding_problems" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "category" "CodingCategory" NOT NULL DEFAULT 'OTHER',
    "xpReward" INTEGER NOT NULL DEFAULT 50,
    "timeLimit" INTEGER NOT NULL DEFAULT 1800,
    "starterCode" JSONB,
    "testCases" JSONB NOT NULL,
    "solution" TEXT,
    "hints" JSONB,
    "timesAttempted" INTEGER NOT NULL DEFAULT 0,
    "timesSolved" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coding_problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coding_submissions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "testResults" JSONB,
    "passedTests" INTEGER NOT NULL DEFAULT 0,
    "totalTests" INTEGER NOT NULL DEFAULT 0,
    "runtime" INTEGER,
    "memory" INTEGER,
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coding_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordle_words" (
    "id" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "hint" TEXT,
    "category" TEXT,
    "xpReward" INTEGER NOT NULL DEFAULT 20,
    "usedOnDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wordle_words_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordle_games" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "guesses" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "status" TEXT NOT NULL DEFAULT 'playing',
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "wordle_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_battles" (
    "id" TEXT NOT NULL,
    "player1Id" TEXT NOT NULL,
    "player2Id" TEXT,
    "category" TEXT,
    "difficulty" TEXT,
    "questionIds" JSONB NOT NULL,
    "player1Answers" JSONB,
    "player2Answers" JSONB,
    "player1Score" INTEGER NOT NULL DEFAULT 0,
    "player2Score" INTEGER NOT NULL DEFAULT 0,
    "winnerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "quiz_battles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "typing_texts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "wordCount" INTEGER NOT NULL,
    "charCount" INTEGER NOT NULL,
    "xpReward" INTEGER NOT NULL DEFAULT 15,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "typing_texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "typing_races" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "textId" TEXT NOT NULL,
    "wpm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timeSpent" INTEGER NOT NULL DEFAULT 0,
    "mistakes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'playing',
    "xpEarned" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "typing_races_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_views" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_activity_feed" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "activityType" TEXT,
    "metadata" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_activity_feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trending_items" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "itemType" TEXT,
    "itemId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "velocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTrending" BOOLEAN NOT NULL DEFAULT true,
    "trendingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trending_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_stats" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "totalUsers" INTEGER NOT NULL DEFAULT 0,
    "totalColleges" INTEGER NOT NULL DEFAULT 0,
    "collegeCount" INTEGER NOT NULL DEFAULT 0,
    "totalConnections" INTEGER NOT NULL DEFAULT 0,
    "activeToday" INTEGER NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_activities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "currentPage" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'offline',

    CONSTRAINT "user_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "participant1Id" TEXT NOT NULL,
    "participant2Id" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "replyToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reels" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "hlsUrl" TEXT,
    "thumbnailUrl" TEXT,
    "previewGifUrl" TEXT,
    "title" TEXT,
    "caption" TEXT,
    "durationSeconds" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1080,
    "height" INTEGER NOT NULL DEFAULT 1920,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "fileSize" INTEGER,
    "audioId" TEXT,
    "audioStartTime" INTEGER NOT NULL DEFAULT 0,
    "muteOriginalAudio" BOOLEAN NOT NULL DEFAULT false,
    "hasOriginalAudio" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" TEXT,
    "locationName" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "placeId" TEXT,
    "collaboratorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isResponse" BOOLEAN NOT NULL DEFAULT false,
    "originalReelId" TEXT,
    "responseType" TEXT,
    "challengeId" TEXT,
    "seriesId" TEXT,
    "pollQuestion" TEXT,
    "pollOptions" JSONB,
    "pollEndsAt" TIMESTAMP(3),
    "quizQuestion" TEXT,
    "quizOptions" JSONB,
    "quizCorrectIndex" INTEGER,
    "codeSnippet" TEXT,
    "codeLanguage" TEXT,
    "codeFileName" TEXT,
    "repoUrl" TEXT,
    "ctaType" TEXT,
    "ctaText" TEXT,
    "ctaUrl" TEXT,
    "productId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "allowComments" BOOLEAN NOT NULL DEFAULT true,
    "allowDuets" BOOLEAN NOT NULL DEFAULT true,
    "allowStitch" BOOLEAN NOT NULL DEFAULT true,
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "allowSharing" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "transcodingProgress" INTEGER NOT NULL DEFAULT 0,
    "processingError" TEXT,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewsCount" INTEGER NOT NULL DEFAULT 0,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "commentsCount" INTEGER NOT NULL DEFAULT 0,
    "sharesCount" INTEGER NOT NULL DEFAULT 0,
    "savesCount" INTEGER NOT NULL DEFAULT 0,
    "duetsCount" INTEGER NOT NULL DEFAULT 0,
    "stitchesCount" INTEGER NOT NULL DEFAULT 0,
    "avgWatchTimeMs" INTEGER,
    "completionRate" DOUBLE PRECISION,
    "engagementRate" DOUBLE PRECISION,
    "publishedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_audio" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "albumName" TEXT,
    "albumArt" TEXT,
    "audioUrl" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "genre" TEXT,
    "mood" TEXT,
    "tempo" INTEGER,
    "isRoyaltyFree" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "licenseType" TEXT,
    "attribution" TEXT,
    "isOriginal" BOOLEAN NOT NULL DEFAULT false,
    "originalCreatorId" TEXT,
    "originalReelId" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "savesCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_audio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_likes" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_comments" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parentId" TEXT,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "repliesCount" INTEGER NOT NULL DEFAULT 0,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isAuthorHeart" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_comment_likes" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_comment_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_saves" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_saves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_views" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT,
    "watchTimeMs" INTEGER NOT NULL DEFAULT 0,
    "completedWatch" BOOLEAN NOT NULL DEFAULT false,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "deviceType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_shares" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shareType" TEXT NOT NULL,
    "platform" TEXT,
    "recipientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_poll_votes" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_quiz_answers" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionId" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_quiz_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_audio_saves" (
    "id" TEXT NOT NULL,
    "audioId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_audio_saves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_challenges" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "rules" TEXT,
    "bannerUrl" TEXT,
    "thumbnailUrl" TEXT,
    "demoReelId" TEXT,
    "audioId" TEXT,
    "hashtag" TEXT NOT NULL,
    "prizeDescription" TEXT,
    "prizeValue" DOUBLE PRECISION,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "participantsCount" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reel_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reel_reports" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reel_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_userId_idx" ON "device_tokens"("userId");

-- CreateIndex
CREATE INDEX "device_tokens_userId_isActive_idx" ON "device_tokens"("userId", "isActive");

-- CreateIndex
CREATE INDEX "profile_views_viewerId_idx" ON "profile_views"("viewerId");

-- CreateIndex
CREATE INDEX "profile_views_viewedId_idx" ON "profile_views"("viewedId");

-- CreateIndex
CREATE INDEX "profile_views_viewedId_viewedAt_idx" ON "profile_views"("viewedId", "viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_streaks_userId_key" ON "engagement_streaks"("userId");

-- CreateIndex
CREATE INDEX "engagement_streaks_userId_idx" ON "engagement_streaks"("userId");

-- CreateIndex
CREATE INDEX "social_proof_leaderboards_period_scope_rank_idx" ON "social_proof_leaderboards"("period", "scope", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "social_proof_leaderboards_userId_period_scope_key" ON "social_proof_leaderboards"("userId", "period", "scope");

-- CreateIndex
CREATE INDEX "connections_requesterId_idx" ON "connections"("requesterId");

-- CreateIndex
CREATE INDEX "connections_addresseeId_idx" ON "connections"("addresseeId");

-- CreateIndex
CREATE INDEX "connections_status_idx" ON "connections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "connections_requesterId_addresseeId_key" ON "connections"("requesterId", "addresseeId");

-- CreateIndex
CREATE INDEX "posts_authorId_idx" ON "posts"("authorId");

-- CreateIndex
CREATE INDEX "posts_createdAt_idx" ON "posts"("createdAt");

-- CreateIndex
CREATE INDEX "posts_authorId_createdAt_idx" ON "posts"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "post_likes_postId_idx" ON "post_likes"("postId");

-- CreateIndex
CREATE INDEX "post_likes_userId_idx" ON "post_likes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "post_likes_postId_userId_key" ON "post_likes"("postId", "userId");

-- CreateIndex
CREATE INDEX "post_comments_postId_idx" ON "post_comments"("postId");

-- CreateIndex
CREATE INDEX "post_comments_authorId_idx" ON "post_comments"("authorId");

-- CreateIndex
CREATE INDEX "post_comments_parentId_idx" ON "post_comments"("parentId");

-- CreateIndex
CREATE INDEX "comment_likes_commentId_idx" ON "comment_likes"("commentId");

-- CreateIndex
CREATE INDEX "comment_likes_userId_idx" ON "comment_likes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_likes_commentId_userId_key" ON "comment_likes"("commentId", "userId");

-- CreateIndex
CREATE INDEX "saved_posts_userId_idx" ON "saved_posts"("userId");

-- CreateIndex
CREATE INDEX "saved_posts_postId_idx" ON "saved_posts"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_posts_userId_postId_key" ON "saved_posts"("userId", "postId");

-- CreateIndex
CREATE UNIQUE INDEX "groups_slug_key" ON "groups"("slug");

-- CreateIndex
CREATE INDEX "groups_creatorId_idx" ON "groups"("creatorId");

-- CreateIndex
CREATE INDEX "groups_isPrivate_idx" ON "groups"("isPrivate");

-- CreateIndex
CREATE INDEX "groups_slug_idx" ON "groups"("slug");

-- CreateIndex
CREATE INDEX "group_members_groupId_idx" ON "group_members"("groupId");

-- CreateIndex
CREATE INDEX "group_members_userId_idx" ON "group_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_groupId_userId_key" ON "group_members"("groupId", "userId");

-- CreateIndex
CREATE INDEX "group_messages_groupId_idx" ON "group_messages"("groupId");

-- CreateIndex
CREATE INDEX "group_messages_senderId_idx" ON "group_messages"("senderId");

-- CreateIndex
CREATE INDEX "group_messages_groupId_createdAt_idx" ON "group_messages"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "group_message_reactions_messageId_idx" ON "group_message_reactions"("messageId");

-- CreateIndex
CREATE INDEX "group_message_reactions_userId_idx" ON "group_message_reactions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "group_message_reactions_messageId_userId_key" ON "group_message_reactions"("messageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "game_stats_userId_key" ON "game_stats"("userId");

-- CreateIndex
CREATE INDEX "game_stats_userId_idx" ON "game_stats"("userId");

-- CreateIndex
CREATE INDEX "xp_transactions_userId_idx" ON "xp_transactions"("userId");

-- CreateIndex
CREATE INDEX "xp_transactions_userId_createdAt_idx" ON "xp_transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "xp_transactions_type_idx" ON "xp_transactions"("type");

-- CreateIndex
CREATE INDEX "trivia_questions_category_idx" ON "trivia_questions"("category");

-- CreateIndex
CREATE INDEX "trivia_questions_difficulty_idx" ON "trivia_questions"("difficulty");

-- CreateIndex
CREATE INDEX "trivia_questions_isActive_idx" ON "trivia_questions"("isActive");

-- CreateIndex
CREATE INDEX "daily_trivia_sessions_userId_idx" ON "daily_trivia_sessions"("userId");

-- CreateIndex
CREATE INDEX "daily_trivia_sessions_date_idx" ON "daily_trivia_sessions"("date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_trivia_sessions_userId_date_key" ON "daily_trivia_sessions"("userId", "date");

-- CreateIndex
CREATE INDEX "trivia_attempts_userId_idx" ON "trivia_attempts"("userId");

-- CreateIndex
CREATE INDEX "trivia_attempts_questionId_idx" ON "trivia_attempts"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "trivia_attempts_userId_questionId_key" ON "trivia_attempts"("userId", "questionId");

-- CreateIndex
CREATE INDEX "coding_problems_difficulty_idx" ON "coding_problems"("difficulty");

-- CreateIndex
CREATE INDEX "coding_problems_category_idx" ON "coding_problems"("category");

-- CreateIndex
CREATE INDEX "coding_problems_isActive_idx" ON "coding_problems"("isActive");

-- CreateIndex
CREATE INDEX "coding_submissions_userId_idx" ON "coding_submissions"("userId");

-- CreateIndex
CREATE INDEX "coding_submissions_problemId_idx" ON "coding_submissions"("problemId");

-- CreateIndex
CREATE INDEX "coding_submissions_userId_problemId_idx" ON "coding_submissions"("userId", "problemId");

-- CreateIndex
CREATE UNIQUE INDEX "wordle_words_word_key" ON "wordle_words"("word");

-- CreateIndex
CREATE INDEX "wordle_words_usedOnDate_idx" ON "wordle_words"("usedOnDate");

-- CreateIndex
CREATE INDEX "wordle_words_isActive_idx" ON "wordle_words"("isActive");

-- CreateIndex
CREATE INDEX "wordle_games_userId_idx" ON "wordle_games"("userId");

-- CreateIndex
CREATE INDEX "wordle_games_wordId_idx" ON "wordle_games"("wordId");

-- CreateIndex
CREATE INDEX "wordle_games_userId_status_idx" ON "wordle_games"("userId", "status");

-- CreateIndex
CREATE INDEX "quiz_battles_player1Id_idx" ON "quiz_battles"("player1Id");

-- CreateIndex
CREATE INDEX "quiz_battles_player2Id_idx" ON "quiz_battles"("player2Id");

-- CreateIndex
CREATE INDEX "quiz_battles_status_idx" ON "quiz_battles"("status");

-- CreateIndex
CREATE INDEX "typing_texts_category_idx" ON "typing_texts"("category");

-- CreateIndex
CREATE INDEX "typing_texts_difficulty_idx" ON "typing_texts"("difficulty");

-- CreateIndex
CREATE INDEX "typing_texts_isActive_idx" ON "typing_texts"("isActive");

-- CreateIndex
CREATE INDEX "typing_races_userId_idx" ON "typing_races"("userId");

-- CreateIndex
CREATE INDEX "typing_races_textId_idx" ON "typing_races"("textId");

-- CreateIndex
CREATE INDEX "typing_races_userId_status_idx" ON "typing_races"("userId", "status");

-- CreateIndex
CREATE INDEX "event_views_eventId_idx" ON "event_views"("eventId");

-- CreateIndex
CREATE INDEX "event_views_viewerId_idx" ON "event_views"("viewerId");

-- CreateIndex
CREATE INDEX "event_views_eventId_viewedAt_idx" ON "event_views"("eventId", "viewedAt");

-- CreateIndex
CREATE INDEX "social_activity_feed_userId_idx" ON "social_activity_feed"("userId");

-- CreateIndex
CREATE INDEX "social_activity_feed_createdAt_idx" ON "social_activity_feed"("createdAt");

-- CreateIndex
CREATE INDEX "social_activity_feed_type_idx" ON "social_activity_feed"("type");

-- CreateIndex
CREATE INDEX "trending_items_type_isActive_idx" ON "trending_items"("type", "isActive");

-- CreateIndex
CREATE INDEX "trending_items_score_idx" ON "trending_items"("score");

-- CreateIndex
CREATE UNIQUE INDEX "trending_items_type_itemId_key" ON "trending_items"("type", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_stats_scope_key" ON "onboarding_stats"("scope");

-- CreateIndex
CREATE INDEX "onboarding_stats_scope_idx" ON "onboarding_stats"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "user_activities_userId_key" ON "user_activities"("userId");

-- CreateIndex
CREATE INDEX "user_activities_userId_idx" ON "user_activities"("userId");

-- CreateIndex
CREATE INDEX "user_activities_isOnline_idx" ON "user_activities"("isOnline");

-- CreateIndex
CREATE INDEX "follows_followerId_idx" ON "follows"("followerId");

-- CreateIndex
CREATE INDEX "follows_followingId_idx" ON "follows"("followingId");

-- CreateIndex
CREATE UNIQUE INDEX "follows_followerId_followingId_key" ON "follows"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "conversations_participant1Id_idx" ON "conversations"("participant1Id");

-- CreateIndex
CREATE INDEX "conversations_participant2Id_idx" ON "conversations"("participant2Id");

-- CreateIndex
CREATE INDEX "conversations_lastMessageAt_idx" ON "conversations"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_participant1Id_participant2Id_key" ON "conversations"("participant1Id", "participant2Id");

-- CreateIndex
CREATE INDEX "messages_conversationId_idx" ON "messages"("conversationId");

-- CreateIndex
CREATE INDEX "messages_senderId_idx" ON "messages"("senderId");

-- CreateIndex
CREATE INDEX "messages_receiverId_idx" ON "messages"("receiverId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "message_reactions_messageId_idx" ON "message_reactions"("messageId");

-- CreateIndex
CREATE INDEX "message_reactions_userId_idx" ON "message_reactions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_messageId_userId_key" ON "message_reactions"("messageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "reels_videoId_key" ON "reels"("videoId");

-- CreateIndex
CREATE INDEX "reels_authorId_idx" ON "reels"("authorId");

-- CreateIndex
CREATE INDEX "reels_audioId_idx" ON "reels"("audioId");

-- CreateIndex
CREATE INDEX "reels_status_idx" ON "reels"("status");

-- CreateIndex
CREATE INDEX "reels_visibility_idx" ON "reels"("visibility");

-- CreateIndex
CREATE INDEX "reels_publishedAt_idx" ON "reels"("publishedAt");

-- CreateIndex
CREATE INDEX "reels_createdAt_idx" ON "reels"("createdAt");

-- CreateIndex
CREATE INDEX "reels_likesCount_idx" ON "reels"("likesCount");

-- CreateIndex
CREATE INDEX "reels_viewsCount_idx" ON "reels"("viewsCount");

-- CreateIndex
CREATE INDEX "reels_challengeId_idx" ON "reels"("challengeId");

-- CreateIndex
CREATE INDEX "reel_audio_usageCount_idx" ON "reel_audio"("usageCount");

-- CreateIndex
CREATE INDEX "reel_audio_genre_idx" ON "reel_audio"("genre");

-- CreateIndex
CREATE INDEX "reel_audio_isRoyaltyFree_idx" ON "reel_audio"("isRoyaltyFree");

-- CreateIndex
CREATE INDEX "reel_likes_userId_idx" ON "reel_likes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_likes_reelId_userId_key" ON "reel_likes"("reelId", "userId");

-- CreateIndex
CREATE INDEX "reel_comments_reelId_idx" ON "reel_comments"("reelId");

-- CreateIndex
CREATE INDEX "reel_comments_authorId_idx" ON "reel_comments"("authorId");

-- CreateIndex
CREATE INDEX "reel_comments_parentId_idx" ON "reel_comments"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_comment_likes_commentId_userId_key" ON "reel_comment_likes"("commentId", "userId");

-- CreateIndex
CREATE INDEX "reel_saves_userId_idx" ON "reel_saves"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_saves_reelId_userId_key" ON "reel_saves"("reelId", "userId");

-- CreateIndex
CREATE INDEX "reel_views_reelId_idx" ON "reel_views"("reelId");

-- CreateIndex
CREATE INDEX "reel_views_userId_idx" ON "reel_views"("userId");

-- CreateIndex
CREATE INDEX "reel_views_createdAt_idx" ON "reel_views"("createdAt");

-- CreateIndex
CREATE INDEX "reel_shares_reelId_idx" ON "reel_shares"("reelId");

-- CreateIndex
CREATE INDEX "reel_shares_userId_idx" ON "reel_shares"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_poll_votes_reelId_userId_key" ON "reel_poll_votes"("reelId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_quiz_answers_reelId_userId_key" ON "reel_quiz_answers"("reelId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_audio_saves_audioId_userId_key" ON "reel_audio_saves"("audioId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "reel_challenges_slug_key" ON "reel_challenges"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "reel_challenges_hashtag_key" ON "reel_challenges"("hashtag");

-- CreateIndex
CREATE INDEX "reel_challenges_startsAt_idx" ON "reel_challenges"("startsAt");

-- CreateIndex
CREATE INDEX "reel_challenges_endsAt_idx" ON "reel_challenges"("endsAt");

-- CreateIndex
CREATE INDEX "reel_challenges_isActive_idx" ON "reel_challenges"("isActive");

-- CreateIndex
CREATE INDEX "reel_reports_reelId_idx" ON "reel_reports"("reelId");

-- CreateIndex
CREATE INDEX "reel_reports_status_idx" ON "reel_reports"("status");

-- CreateIndex
CREATE INDEX "users_isBanned_idx" ON "users"("isBanned");

-- CreateIndex
CREATE INDEX "users_isAdmin_idx" ON "users"("isAdmin");

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewedId_fkey" FOREIGN KEY ("viewedId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_streaks" ADD CONSTRAINT "engagement_streaks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "post_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "post_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_posts" ADD CONSTRAINT "saved_posts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_posts" ADD CONSTRAINT "saved_posts_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "group_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_message_reactions" ADD CONSTRAINT "group_message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "group_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_stats" ADD CONSTRAINT "game_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordle_games" ADD CONSTRAINT "wordle_games_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "wordle_words"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_battles" ADD CONSTRAINT "quiz_battles_player1Id_fkey" FOREIGN KEY ("player1Id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_battles" ADD CONSTRAINT "quiz_battles_player2Id_fkey" FOREIGN KEY ("player2Id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "typing_races" ADD CONSTRAINT "typing_races_textId_fkey" FOREIGN KEY ("textId") REFERENCES "typing_texts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_activity_feed" ADD CONSTRAINT "social_activity_feed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_activities" ADD CONSTRAINT "user_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant1Id_fkey" FOREIGN KEY ("participant1Id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_participant2Id_fkey" FOREIGN KEY ("participant2Id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "reel_audio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_originalReelId_fkey" FOREIGN KEY ("originalReelId") REFERENCES "reels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reels" ADD CONSTRAINT "reels_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "reel_challenges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_likes" ADD CONSTRAINT "reel_likes_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_likes" ADD CONSTRAINT "reel_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_comments" ADD CONSTRAINT "reel_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "reel_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_comment_likes" ADD CONSTRAINT "reel_comment_likes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "reel_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_saves" ADD CONSTRAINT "reel_saves_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_views" ADD CONSTRAINT "reel_views_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_shares" ADD CONSTRAINT "reel_shares_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_poll_votes" ADD CONSTRAINT "reel_poll_votes_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_quiz_answers" ADD CONSTRAINT "reel_quiz_answers_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_audio_saves" ADD CONSTRAINT "reel_audio_saves_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "reel_audio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reel_reports" ADD CONSTRAINT "reel_reports_reelId_fkey" FOREIGN KEY ("reelId") REFERENCES "reels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
