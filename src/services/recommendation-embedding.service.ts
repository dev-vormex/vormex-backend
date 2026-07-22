import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, prismaRead } from '../config/prisma';
import { growthJobs } from '../data/growth-hub.catalog';

const MODEL = process.env.DISCOVERY_EMBEDDING_MODEL || 'text-embedding-3-small';
const WEB_BASE_URL = String(process.env.PUBLIC_WEB_BASE_URL || process.env.WEB_BASE_URL || 'https://vormex.in').replace(/\/$/, '');

type DocumentInput = {
  entityType: 'post' | 'reel' | 'job' | 'event';
  entityId: string;
  ownerId?: string | null;
  canonicalUrl: string;
  publicText: string;
  metadata: Record<string, unknown>;
};

type TimedVector = { vector: number[]; occurredAt: Date };

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEmbeddingText(parts: unknown[]): string {
  return parts
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .map(String)
    .join(' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== 1536 || vector.some((value) => !Number.isFinite(value))) throw new Error('Invalid embedding shape');
  return `[${vector.join(',')}]`;
}

function parseVector(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const parsed = trimmed.slice(1, -1).split(',').map(Number);
  return parsed.length === 1536 && parsed.every(Number.isFinite) ? parsed : null;
}

function normalizeVector(vector: number[]): number[] | null {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 && Number.isFinite(norm) ? vector.map((value) => value / norm) : null;
}

function decayedCentroid(entries: TimedVector[], now: Date): number[] | null {
  if (entries.length === 0) return null;
  const output = Array(1536).fill(0) as number[];
  let totalWeight = 0;
  for (const entry of entries) {
    const ageDays = Math.max(0, now.getTime() - entry.occurredAt.getTime()) / 86_400_000;
    const weight = Math.pow(0.5, ageDays / 30);
    totalWeight += weight;
    entry.vector.forEach((value, index) => { output[index] += value * weight; });
  }
  if (totalWeight <= 0) return null;
  return normalizeVector(output.map((value) => value / totalWeight));
}

function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const output = Array(1536).fill(0) as number[];
  vectors.forEach((vector) => vector.forEach((value, index) => { output[index] += value; }));
  return normalizeVector(output.map((value) => value / vectors.length));
}

export function blendRecommendationPreferenceVector(input: {
  profileVector?: number[] | null;
  interactions: TimedVector[];
  negativeVectors: number[][];
  now?: Date;
}): { positiveVector: number[] | null; negativeVector: number[] | null; behavioralWeight: number } {
  const profile = input.profileVector ? normalizeVector(input.profileVector) : null;
  const interaction = decayedCentroid(input.interactions, input.now || new Date());
  const negative = centroid(input.negativeVectors);
  const behavioralWeight = Math.min(0.70, 0.70 * input.interactions.length / 50);
  if (!profile && !interaction) return { positiveVector: null, negativeVector: negative, behavioralWeight };
  const output = Array(1536).fill(0) as number[];
  for (let index = 0; index < output.length; index += 1) {
    const base = profile && interaction
      ? (1 - behavioralWeight) * profile[index] + behavioralWeight * interaction[index]
      : (profile?.[index] ?? interaction?.[index] ?? 0);
    output[index] = base - 0.20 * (negative?.[index] || 0);
  }
  return { positiveVector: normalizeVector(output), negativeVector: negative, behavioralWeight };
}

async function createEmbedding(text: string): Promise<number[] | null> {
  if (process.env.RECOMMENDATION_SEMANTIC_ENABLED !== 'true' || !process.env.OPENAI_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 12_000), dimensions: 1536 }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`);
    const payload = await response.json() as any;
    return Array.isArray(payload?.data?.[0]?.embedding) ? payload.data[0].embedding : null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadDocuments(): Promise<DocumentInput[]> {
  const [posts, reels, events] = await Promise.all([
    prismaRead.post.findMany({
      where: { isActive: true, visibility: 'public' },
      select: { id: true, authorId: true, content: true, type: true, metadata: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' }, take: 500,
    }),
    prismaRead.reels.findMany({
      where: { status: 'ready', visibility: 'public' },
      select: { id: true, authorId: true, title: true, caption: true, skills: true, topics: true, hashtags: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' }, take: 500,
    }),
    prismaRead.campus_events.findMany({
      where: { endsAt: { gte: new Date() } },
      select: { id: true, organizerId: true, title: true, description: true, type: true, campus: true, tags: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' }, take: 500,
    }),
  ]);
  return [
    ...posts.map((post) => {
      const metadata = post.metadata && typeof post.metadata === 'object' && !Array.isArray(post.metadata)
        ? post.metadata as Record<string, unknown>
        : {};
      return { entityType: 'post' as const, entityId: post.id, ownerId: post.authorId,
        canonicalUrl: `${WEB_BASE_URL}/post/${post.id}`,
        publicText: safeEmbeddingText([post.content, post.type, metadata.articleTitle, metadata.articleDescription,
          metadata.articleTags, metadata.documentTitle, metadata.linkTitle]), metadata: { type: post.type } };
    }),
    ...reels.map((reel) => ({ entityType: 'reel' as const, entityId: reel.id, ownerId: reel.authorId,
      canonicalUrl: `${WEB_BASE_URL}/reels/${reel.id}`, publicText: safeEmbeddingText([reel.title, reel.caption, reel.skills, reel.topics, reel.hashtags]), metadata: { skills: reel.skills, topics: reel.topics } })),
    ...growthJobs.map((job) => ({ entityType: 'job' as const, entityId: job.id, ownerId: null,
      canonicalUrl: `${WEB_BASE_URL}/jobs/${job.slug}`, publicText: safeEmbeddingText([job.title, job.description, job.location, job.experienceLevel, job.skills]), metadata: { skills: job.skills, companyId: job.companyId } })),
    ...events.map((event) => ({ entityType: 'event' as const, entityId: event.id, ownerId: event.organizerId,
      canonicalUrl: `${WEB_BASE_URL}/events/${event.id}`, publicText: safeEmbeddingText([event.title, event.description, event.type, event.campus, event.tags]), metadata: { campus: event.campus, tags: event.tags } })),
  ].filter((document) => document.publicText.trim().length > 0);
}

export async function loadCachedSemanticScores(
  userId: string,
  entityType: DocumentInput['entityType'] | 'profile',
  entityIds: string[]
): Promise<Map<string, number>> {
  if (process.env.RECOMMENDATION_SEMANTIC_ENABLED !== 'true' || entityIds.length === 0) return new Map();
  const uniqueIds = Array.from(new Set(entityIds)).slice(0, 500);
  const rows = await prismaRead.$queryRaw<Array<{ entityId: string; similarity: number }>>(Prisma.sql`
    SELECT d."entityId", 1 - (d."embedding" <=> p."positiveVector") AS similarity
    FROM "recommendation_user_profiles" p
    JOIN "discovery_documents" d ON d."entityType" = ${entityType}
    WHERE p."userId" = ${userId} AND p."positiveVector" IS NOT NULL
      AND d."eligibilityStatus" = 'eligible' AND d."embedding" IS NOT NULL
      AND d."entityId" IN (${Prisma.join(uniqueIds)})
  `).catch(() => []);
  return new Map(rows.map((row) => [
    String(row.entityId),
    Math.min(1, Math.max(0, Number(row.similarity || 0))),
  ] as const));
}

async function refreshRecommendationUserProfiles(now = new Date(), batchSize = 100): Promise<void> {
  const users = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT u."id", u."name", u."username", u."headline", u."bio", u."college", u."branch", u."interests",
      COALESCE((
        SELECT array_agg(s."name" ORDER BY s."name") FROM "user_skills" us
        JOIN "skills" s ON s."id" = us."skillId" WHERE us."userId" = u."id"
      ), ARRAY[]::text[]) AS skills,
      p."vectorContentHash", d."contentHash" AS profile_document_hash,
      d."embedding"::text AS profile_embedding
    FROM "users" u
    LEFT JOIN "recommendation_user_profiles" p ON p."userId" = u."id"
    LEFT JOIN "discovery_documents" d ON d."entityType" = 'profile' AND d."entityId" = u."id"
      AND d."eligibilityStatus" = 'eligible'
    WHERE u."isBanned" = false
      AND (u."safetyRestrictedUntil" IS NULL OR u."safetyRestrictedUntil" < CURRENT_TIMESTAMP)
      AND (u."safetySuspendedUntil" IS NULL OR u."safetySuspendedUntil" < CURRENT_TIMESTAMP)
    ORDER BY p."vectorUpdatedAt" ASC NULLS FIRST, u."lastActiveAt" DESC NULLS LAST
    LIMIT ${Math.max(1, Math.min(500, batchSize))}
  `);
  if (users.length === 0) return;
  const userIds = users.map((user) => String(user.id));
  const interactions = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    WITH deduplicated AS (
      SELECT DISTINCT ON (e."userId", e."entityType", e."entityId")
        e."userId", e."occurredAt", d."embedding"::text AS embedding
      FROM "recommendation_events" e
      JOIN "discovery_documents" d ON d."entityType" = lower(e."entityType") AND d."entityId" = e."entityId"
      WHERE e."userId" IN (${Prisma.join(userIds)}) AND e."isBoosted" = false
        AND e."eventType" IN ('REACTION', 'COMMENT')
        AND e."occurredAt" >= ${new Date(now.getTime() - 30 * 86_400_000)}
        AND d."eligibilityStatus" = 'eligible' AND d."embedding" IS NOT NULL
      ORDER BY e."userId", e."entityType", e."entityId", e."occurredAt" DESC
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY "userId" ORDER BY "occurredAt" DESC) AS sequence
      FROM deduplicated
    )
    SELECT * FROM ranked WHERE sequence <= 50
  `);
  const negatives = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT f."userId", d."embedding"::text AS embedding
    FROM "recommendation_feedback" f
    JOIN "discovery_documents" d ON d."entityType" = lower(f."entityType") AND d."entityId" = f."entityId"
    WHERE f."userId" IN (${Prisma.join(userIds)}) AND f."isActive" = true
      AND d."eligibilityStatus" = 'eligible' AND d."embedding" IS NOT NULL
  `);
  const interactionsByUser = new Map<string, TimedVector[]>();
  for (const row of interactions) {
    const vector = parseVector(row.embedding);
    if (!vector) continue;
    const list = interactionsByUser.get(String(row.userId)) || [];
    list.push({ vector, occurredAt: new Date(row.occurredAt) });
    interactionsByUser.set(String(row.userId), list);
  }
  const negativesByUser = new Map<string, number[][]>();
  for (const row of negatives) {
    const vector = parseVector(row.embedding);
    if (!vector) continue;
    const list = negativesByUser.get(String(row.userId)) || [];
    list.push(vector);
    negativesByUser.set(String(row.userId), list);
  }

  for (const user of users) {
    const publicText = safeEmbeddingText([user.name, user.username, user.headline, user.bio, user.college, user.branch,
      user.interests, user.skills]);
    const profileHash = hash(publicText);
    let profileVector = user.profile_document_hash === profileHash ? parseVector(user.profile_embedding) : null;
    if (!profileVector && publicText.trim()) profileVector = await createEmbedding(publicText).catch(() => null);
    const userInteractions = interactionsByUser.get(String(user.id)) || [];
    const blended = blendRecommendationPreferenceVector({
      profileVector,
      interactions: userInteractions,
      negativeVectors: negativesByUser.get(String(user.id)) || [],
      now,
    });
    if (!blended.positiveVector) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "recommendation_user_profiles"
         ("id", "userId", "interactionCount", "positiveVector", "negativeVector", "vectorContentHash",
          "vectorUpdatedAt", "featureState", "updatedAt")
       VALUES ($1, $2, $3, $4::vector, $5::vector, $6, CURRENT_TIMESTAMP, $7::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT ("userId") DO UPDATE SET
         "interactionCount" = EXCLUDED."interactionCount", "positiveVector" = EXCLUDED."positiveVector",
         "negativeVector" = EXCLUDED."negativeVector", "vectorContentHash" = EXCLUDED."vectorContentHash",
         "vectorUpdatedAt" = CURRENT_TIMESTAMP, "featureState" = EXCLUDED."featureState", "updatedAt" = CURRENT_TIMESTAMP`,
      randomUUID(), String(user.id), userInteractions.length, vectorLiteral(blended.positiveVector),
      blended.negativeVector ? vectorLiteral(blended.negativeVector) : null, profileHash,
      JSON.stringify({ behavioralWeight: blended.behavioralWeight, interactionHalfLifeDays: 30, negativeWeight: 0.20 })
    );
  }
}

export async function reindexRecommendationDocuments(): Promise<{ indexed: number; embedded: number }> {
  const documents = await loadDocuments();
  for (const document of documents) {
    const contentHash = hash(document.publicText);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "discovery_documents"
        ("id", "entityType", "entityId", "ownerId", "canonicalUrl", "publicText", "metadata", "contentHash", "eligibilityStatus", "embedding", "updatedAt")
      VALUES
        (${randomUUID()}, ${document.entityType}, ${document.entityId}, ${document.ownerId || null}, ${document.canonicalUrl},
         ${document.publicText}, ${JSON.stringify(document.metadata)}::jsonb, ${contentHash}, 'eligible', NULL, CURRENT_TIMESTAMP)
      ON CONFLICT ("entityType", "entityId") DO UPDATE SET
        "ownerId" = EXCLUDED."ownerId", "canonicalUrl" = EXCLUDED."canonicalUrl", "publicText" = EXCLUDED."publicText",
        "metadata" = EXCLUDED."metadata", "embedding" = CASE WHEN "discovery_documents"."contentHash" = EXCLUDED."contentHash"
          THEN "discovery_documents"."embedding" ELSE NULL END,
        "contentHash" = EXCLUDED."contentHash", "eligibilityStatus" = 'eligible', "updatedAt" = CURRENT_TIMESTAMP
    `);
  }
  const missing = await prismaRead.$queryRaw<any[]>(Prisma.sql`
    SELECT "entityType", "entityId", "publicText" FROM "discovery_documents"
    WHERE "entityType" IN ('post', 'reel', 'job', 'event') AND "eligibilityStatus" = 'eligible' AND "embedding" IS NULL
    ORDER BY "updatedAt" DESC LIMIT 100
  `);
  let embedded = 0;
  for (const document of missing) {
    const embedding = await createEmbedding(String(document.publicText)).catch(() => null);
    if (!embedding) continue;
    await prisma.$executeRawUnsafe(
      `UPDATE "discovery_documents" SET "embedding" = $1::vector, "updatedAt" = CURRENT_TIMESTAMP WHERE "entityType" = $2 AND "entityId" = $3`,
      vectorLiteral(embedding), document.entityType, document.entityId
    );
    embedded += 1;
  }
  await refreshRecommendationUserProfiles();
  return { indexed: documents.length, embedded };
}
