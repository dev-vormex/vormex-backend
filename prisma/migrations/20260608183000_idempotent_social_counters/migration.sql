DELETE FROM "reel_reports" rr
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "reelId", "reporterId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "reel_reports"
) ranked
WHERE rr.id = ranked.id
  AND ranked.rn > 1;

DELETE FROM "reel_shares" rs
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY "reelId", "userId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "reel_shares"
) ranked
WHERE rs.id = ranked.id
  AND ranked.rn > 1;

UPDATE "reels" r
SET "sharesCount" = COALESCE(counts.count, 0)
FROM (
  SELECT "reelId", COUNT(*)::int AS count
  FROM "reel_shares"
  GROUP BY "reelId"
) counts
WHERE r.id = counts."reelId";

UPDATE "reels" r
SET "sharesCount" = 0
WHERE NOT EXISTS (
  SELECT 1 FROM "reel_shares" rs WHERE rs."reelId" = r.id
);

CREATE UNIQUE INDEX IF NOT EXISTS "reel_reports_reelId_reporterId_key"
ON "reel_reports"("reelId", "reporterId");

CREATE UNIQUE INDEX IF NOT EXISTS "reel_shares_reelId_userId_key"
ON "reel_shares"("reelId", "userId");
