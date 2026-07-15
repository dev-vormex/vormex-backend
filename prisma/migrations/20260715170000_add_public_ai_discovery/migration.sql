CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "webDiscoveryEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "aiDiscoveryEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "discoveryVisibilityUpdatedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "discovery_documents" (
  "id" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "ownerId" TEXT,
  "canonicalUrl" TEXT NOT NULL,
  "publicText" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "contentHash" TEXT NOT NULL,
  "eligibilityStatus" TEXT NOT NULL DEFAULT 'eligible',
  "embedding" vector(1536),
  "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("publicText", ''))) STORED,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discovery_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "discovery_documents_entity_key"
  ON "discovery_documents"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "discovery_documents_owner_idx"
  ON "discovery_documents"("ownerId");
CREATE INDEX IF NOT EXISTS "discovery_documents_eligibility_idx"
  ON "discovery_documents"("entityType", "eligibilityStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "discovery_documents_search_idx"
  ON "discovery_documents" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "discovery_documents_embedding_idx"
  ON "discovery_documents" USING hnsw ("embedding" vector_cosine_ops);
