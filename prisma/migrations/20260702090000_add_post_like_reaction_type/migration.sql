-- Add reaction type to post likes (LIKE, CELEBRATE, SUPPORT, INSIGHTFUL, CURIOUS)
ALTER TABLE "post_likes" ADD COLUMN "reactionType" TEXT NOT NULL DEFAULT 'LIKE';
