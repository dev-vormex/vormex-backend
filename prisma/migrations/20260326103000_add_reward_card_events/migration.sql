CREATE TABLE IF NOT EXISTS "reward_card_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "candidate_user_id" TEXT,
    "session_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "card_type" TEXT,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reward_card_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reward_card_events_user_id_created_at_idx"
ON "reward_card_events"("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "reward_card_events_user_id_candidate_user_id_created_at_idx"
ON "reward_card_events"("user_id", "candidate_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "reward_card_events_session_id_idx"
ON "reward_card_events"("session_id");

CREATE UNIQUE INDEX IF NOT EXISTS "reward_card_events_candidate_dedupe_idx"
ON "reward_card_events"("user_id", "candidate_user_id", "session_id", "action")
WHERE "candidate_user_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "reward_card_events_session_dedupe_idx"
ON "reward_card_events"("user_id", "session_id", "action")
WHERE "candidate_user_id" IS NULL;
