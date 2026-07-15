import { createHash } from 'crypto';
import OpenAI from 'openai';
import { prismaRead, prismaWrite } from '../config/prisma';
import { growthJobs, learningPaths } from '../data/growth-hub.catalog';
import { submitIndexNow } from './indexnow.service';

export type DiscoveryChannel = 'web' | 'ai';

export interface PublicPeopleSearchInput {
  goal: string;
  skills?: string[];
  interests?: string[];
  location?: string;
  limit?: number;
}

export interface PublicPersonResult {
  username: string;
  name: string;
  headline: string | null;
  bio: string | null;
  avatar: string | null;
  skills: string[];
  interests: string[];
  location: string | null;
  profileUrl: string;
  verified: boolean;
  openToOpportunities: boolean;
  matchScore: number;
  matchScoreBand: 'strong' | 'good' | 'related';
  matchReasons: string[];
}

export interface PublicProfileResult extends Omit<PublicPersonResult, 'matchScore' | 'matchScoreBand' | 'matchReasons'> {
  bannerImage: string | null;
  college: string | null;
  branch: string | null;
  degree: string | null;
  graduationYear: number | null;
  portfolioUrl: string | null;
  linkedinUrl: string | null;
  githubProfileUrl: string | null;
  otherSocialUrls: unknown | null;
  experiences: Array<{ title: string; company: string; type: string; location: string | null; startDate: string; endDate: string | null; current: boolean; description: string | null; skills: string[]; logo: string | null }>;
  education: Array<{ school: string; degree: string; fieldOfStudy: string; startDate: string; endDate: string | null; current: boolean; grade: string | null; activities: string | null; description: string | null; logo: string | null }>;
  projects: Array<{ id: string; title: string; description: string; url: string | null; role: string | null; techStack: string[]; startDate: string; endDate: string | null; current: boolean; projectUrl: string | null; githubUrl: string | null; otherLinks: unknown | null; images: string[]; featured: boolean }>;
  certificates: Array<{ name: string; issuingOrganization: string; issueDate: string; expiryDate: string | null; doesNotExpire: boolean; credentialId: string | null; credentialUrl: string | null }>;
  achievements: Array<{ title: string; type: string; organization: string; date: string; description: string | null; certificateUrl: string | null }>;
  publicTextPosts: Array<{ id: string; content: string; url: string; likesCount: number; commentsCount: number; sharesCount: number; createdAt: string }>;
  sectionCounts: { experiences: number; education: number; projects: number; certificates: number; achievements: number; publicTextPosts: number };
  indexable: boolean;
  updatedAt: string;
}

export interface PublicOpportunityResult {
  id: string;
  type: 'job' | 'learning' | 'group' | 'event' | 'hackathon';
  title: string;
  description: string;
  url: string;
  location: string | null;
  skills: string[];
  startsAt?: string | null;
}

type Candidate = Awaited<ReturnType<typeof loadPeopleCandidates>>[number];

const WEB_BASE_URL = (process.env.PUBLIC_WEB_BASE_URL || process.env.FRONTEND_URL || 'https://www.vormex.in')
  .replace(/\/+$/, '')
  .replace('https://vormex.in', 'https://www.vormex.in');
const EMBEDDING_MODEL = process.env.DISCOVERY_EMBEDDING_MODEL || 'text-embedding-3-small';
const MAX_QUERY_CHARS = 240;
const MAX_LIST_VALUES = 10;

let openAIClient: OpenAI | null | undefined;

function getOpenAIClient(): OpenAI | null {
  if (openAIClient !== undefined) return openAIClient;
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
  openAIClient = apiKey ? new OpenAI({ apiKey, timeout: 12_000, maxRetries: 1 }) : null;
  return openAIClient;
}

export function publicWebBaseUrl(): string {
  return WEB_BASE_URL;
}

export function normalizeDiscoveryText(value: unknown, maxLength = MAX_QUERY_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function normalizeDiscoveryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => normalizeDiscoveryText(item, 48).toLowerCase())
    .filter(Boolean)))
    .slice(0, MAX_LIST_VALUES);
}

const INTENT_SYNONYMS: Record<string, string[]> = {
  code: ['coding', 'programming', 'developer', 'software'],
  coding: ['code', 'programming', 'developer', 'software'],
  learn: ['learning', 'mentor', 'study'],
  startup: ['founder', 'entrepreneur', 'business', 'builder'],
  ai: ['artificial intelligence', 'machine learning', 'ml', 'data science'],
  design: ['designer', 'ui', 'ux', 'product design'],
  mentor: ['mentorship', 'teach', 'guide'],
};

export function tokenizeDiscoveryIntent(input: PublicPeopleSearchInput): string[] {
  const raw = [input.goal, ...(input.skills || []), ...(input.interests || [])]
    .join(' ')
    .toLowerCase();
  const base = raw.match(/[a-z0-9+#.]{2,}/g) || [];
  const expanded = base.flatMap((token) => [token, ...(INTENT_SYNONYMS[token] || [])]);
  return Array.from(new Set(expanded)).slice(0, 30);
}

export function isPublicUserEligible(user: {
  isBanned: boolean;
  safetyRestrictedUntil: Date | null;
  safetySuspendedUntil: Date | null;
  webDiscoveryEnabled: boolean;
  aiDiscoveryEnabled: boolean;
  username: string;
  name: string;
}, channel: DiscoveryChannel, now = new Date()): boolean {
  if (user.isBanned || !user.username.trim() || !user.name.trim()) return false;
  if (user.safetyRestrictedUntil && user.safetyRestrictedUntil > now) return false;
  if (user.safetySuspendedUntil && user.safetySuspendedUntil > now) return false;
  return channel === 'web' ? user.webDiscoveryEnabled : user.aiDiscoveryEnabled;
}

function hasIndexableProfileContent(user: Candidate): boolean {
  return Boolean(
    normalizeDiscoveryText(user.headline)
    || normalizeDiscoveryText(user.bio)
    || user.interests.length
    || user.skills.length
    || user.projects.length
  );
}

function coarseLocation(user: Candidate): string | null {
  if (user.shareLocationPublic !== true) return null;
  const parts = [user.currentCity, user.currentState, user.currentCountry]
    .map((part) => normalizeDiscoveryText(part, 80))
    .filter(Boolean);
  return parts.length ? Array.from(new Set(parts)).join(', ') : null;
}

async function createEmbedding(text: string): Promise<number[] | null> {
  const client = getOpenAIClient();
  if (!client || process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return null;
  try {
    const result = await client.embeddings.create({ model: EMBEDDING_MODEL, input: text, encoding_format: 'float' });
    return result.data[0]?.embedding || null;
  } catch (error) {
    console.warn('Public discovery embedding request failed; using lexical ranking.', error instanceof Error ? error.message : error);
    return null;
  }
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => Number(value).toFixed(8)).join(',')}]`;
}

async function semanticProfileScores(query: string): Promise<Map<string, number>> {
  const embedding = await createEmbedding(query);
  if (!embedding) return new Map();
  try {
    const rows = await prismaRead.$queryRawUnsafe<Array<{ entityId: string; similarity: number }>>(
      `SELECT "entityId", 1 - ("embedding" <=> $1::vector) AS similarity
       FROM "discovery_documents"
       WHERE "entityType" = 'profile' AND "eligibilityStatus" = 'eligible' AND "embedding" IS NOT NULL
       ORDER BY "embedding" <=> $1::vector
       LIMIT 60`,
      vectorLiteral(embedding)
    );
    return new Map(rows.map((row) => [row.entityId, Math.max(0, Math.min(1, Number(row.similarity) || 0))]));
  } catch {
    return new Map();
  }
}

async function loadPeopleCandidates(input: PublicPeopleSearchInput) {
  const tokens = tokenizeDiscoveryIntent(input);
  const queryTerms = tokens.slice(0, 12);
  const location = normalizeDiscoveryText(input.location, 80);
  const searchOr: any[] = [];
  for (const term of queryTerms) {
    searchOr.push(
      { name: { contains: term, mode: 'insensitive' } },
      { username: { contains: term, mode: 'insensitive' } },
      { headline: { contains: term, mode: 'insensitive' } },
      { bio: { contains: term, mode: 'insensitive' } },
      { college: { contains: term, mode: 'insensitive' } },
      { branch: { contains: term, mode: 'insensitive' } },
      { interests: { has: term } },
      { skills: { some: { skill: { name: { contains: term, mode: 'insensitive' } } } } }
    );
  }

  return prismaRead.user.findMany({
    where: {
      isBanned: false,
      AND: [
        { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lte: new Date() } }] },
        { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lte: new Date() } }] },
        ...(searchOr.length ? [{ OR: searchOr }] : []),
        ...(location ? [{ OR: [
          { currentCity: { contains: location, mode: 'insensitive' as const } },
          { currentState: { contains: location, mode: 'insensitive' as const } },
          { currentCountry: { contains: location, mode: 'insensitive' as const } },
          { college: { contains: location, mode: 'insensitive' as const } },
        ] }] : []),
      ],
    },
    take: 80,
    orderBy: [{ isVerified: 'desc' }, { lastActiveAt: 'desc' }, { updatedAt: 'desc' }],
    select: {
      id: true,
      username: true,
      name: true,
      profileImage: true,
      headline: true,
      bio: true,
      interests: true,
      college: true,
      branch: true,
      degree: true,
      portfolioUrl: true,
      linkedinUrl: true,
      githubProfileUrl: true,
      isVerified: true,
      isOpenToOpportunities: true,
      isBanned: true,
      safetyRestrictedUntil: true,
      safetySuspendedUntil: true,
      webDiscoveryEnabled: true,
      aiDiscoveryEnabled: true,
      shareLocationPublic: true,
      currentCity: true,
      currentState: true,
      currentCountry: true,
      lastActiveAt: true,
      updatedAt: true,
      skills: { select: { skill: { select: { name: true } } }, take: 20 },
      projects: {
        select: { id: true, name: true, description: true, projectUrl: true },
        orderBy: [{ featured: 'desc' }, { updatedAt: 'desc' }],
        take: 6,
      },
    },
  });
}

function scoreCandidate(candidate: Candidate, input: PublicPeopleSearchInput, semanticScore?: number) {
  const intentTokens = tokenizeDiscoveryIntent(input);
  const skills = candidate.skills.map((entry) => entry.skill.name).filter(Boolean);
  const haystack = [candidate.name, candidate.username, candidate.headline, candidate.bio, candidate.college, candidate.branch, ...skills, ...candidate.interests]
    .filter(Boolean).join(' ').toLowerCase();
  const matched = intentTokens.filter((token) => haystack.includes(token.toLowerCase()));
  const lexical = intentTokens.length ? Math.min(1, matched.length / Math.min(intentTokens.length, 8)) : 0.4;
  const completeness = [candidate.headline, candidate.bio, skills.length, candidate.interests.length, candidate.projects.length]
    .filter(Boolean).length / 5;
  const trust = completeness * 0.6 + (candidate.isVerified ? 0.4 : 0);
  const ageDays = candidate.lastActiveAt ? Math.max(0, (Date.now() - candidate.lastActiveAt.getTime()) / 86_400_000) : 365;
  const recency = Math.exp(-ageDays / 60);
  const semanticWeight = typeof semanticScore === 'number' ? 0.45 : 0;
  const denominator = semanticWeight + 0.30 + 0.10 + 0.10 + 0.05;
  const weighted = (semanticWeight * (semanticScore || 0)) + (0.30 * lexical) + (0.10 * trust) + (0.10 * recency)
    + (0.05 * (candidate.isOpenToOpportunities ? 1 : 0));
  const score = Math.round((weighted / denominator) * 100);

  const requestedSkills = normalizeDiscoveryList(input.skills);
  const skillMatches = skills.filter((skill) => requestedSkills.some((requested) => skill.toLowerCase().includes(requested)));
  const requestedInterests = normalizeDiscoveryList(input.interests);
  const interestMatches = candidate.interests.filter((interest) => requestedInterests.some((requested) => interest.toLowerCase().includes(requested)));
  const reasons: string[] = [];
  if (skillMatches.length) reasons.push(`Skills include ${skillMatches.slice(0, 3).join(', ')}`);
  if (interestMatches.length) reasons.push(`Interested in ${interestMatches.slice(0, 3).join(', ')}`);
  if (!reasons.length && matched.length) reasons.push(`Profile matches ${matched.slice(0, 3).join(', ')}`);
  if (candidate.isOpenToOpportunities) reasons.push('Open to opportunities and collaboration');
  if (candidate.isVerified) reasons.push('Verified Vormex profile');
  if (!reasons.length) reasons.push('Related public profile on Vormex');

  return { score, reasons: reasons.slice(0, 3) };
}

function toPersonResult(candidate: Candidate, score: number, reasons: string[]): PublicPersonResult {
  return {
    username: candidate.username,
    name: candidate.name,
    headline: candidate.headline,
    bio: candidate.bio,
    avatar: candidate.profileImage,
    skills: candidate.skills.map((entry) => entry.skill.name),
    interests: candidate.interests,
    location: coarseLocation(candidate),
    profileUrl: `${WEB_BASE_URL}/people/${encodeURIComponent(candidate.username)}`,
    verified: candidate.isVerified,
    openToOpportunities: candidate.isOpenToOpportunities,
    matchScore: score,
    matchScoreBand: score >= 75 ? 'strong' : score >= 50 ? 'good' : 'related',
    matchReasons: reasons,
  };
}

export async function searchPublicPeople(input: PublicPeopleSearchInput, channel: DiscoveryChannel = 'ai'): Promise<PublicPersonResult[]> {
  if (channel === 'ai' && process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return [];
  const normalized: PublicPeopleSearchInput = {
    goal: normalizeDiscoveryText(input.goal),
    skills: normalizeDiscoveryList(input.skills),
    interests: normalizeDiscoveryList(input.interests),
    location: normalizeDiscoveryText(input.location, 80),
    limit: Math.min(10, Math.max(1, Number(input.limit) || 5)),
  };
  if (!normalized.goal && !normalized.skills?.length && !normalized.interests?.length) return [];

  const queryText = [normalized.goal, ...(normalized.skills || []), ...(normalized.interests || [])].join(' ');
  const [candidates, semanticScores] = await Promise.all([
    loadPeopleCandidates(normalized),
    channel === 'ai' ? semanticProfileScores(queryText) : Promise.resolve(new Map<string, number>()),
  ]);
  return candidates
    .filter((candidate) => isPublicUserEligible(candidate, channel) && hasIndexableProfileContent(candidate))
    .map((candidate) => {
      const ranked = scoreCandidate(candidate, normalized, semanticScores.get(candidate.id));
      return toPersonResult(candidate, ranked.score, ranked.reasons);
    })
    .sort((left, right) => right.matchScore - left.matchScore || left.username.localeCompare(right.username))
    .slice(0, normalized.limit);
}

export async function listPublicPeople(limit = 24): Promise<PublicPersonResult[]> {
  const input: PublicPeopleSearchInput = { goal: '', limit: Math.min(50, Math.max(1, Number(limit) || 24)) };
  const candidates = await loadPeopleCandidates(input);
  return candidates
    .filter((candidate) => isPublicUserEligible(candidate, 'web') && hasIndexableProfileContent(candidate))
    .map((candidate) => {
      const ranked = scoreCandidate(candidate, input);
      return toPersonResult(candidate, ranked.score, ranked.reasons);
    })
    .sort((left, right) => right.matchScore - left.matchScore || left.username.localeCompare(right.username))
    .slice(0, input.limit);
}

export async function getPublicProfile(username: string, channel: DiscoveryChannel = 'web'): Promise<PublicProfileResult | null> {
  if (channel === 'ai' && process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return null;
  const normalized = normalizeDiscoveryText(username.replace(/^@/, ''), 40).toLowerCase();
  if (!normalized) return null;
  const user = await prismaRead.user.findFirst({
    where: { username: { equals: normalized, mode: 'insensitive' } },
    select: {
      id: true, username: true, name: true, profileImage: true, bannerImageUrl: true, headline: true, bio: true, interests: true,
      college: true, branch: true, degree: true, graduationYear: true, portfolioUrl: true, linkedinUrl: true,
      githubProfileUrl: true, otherSocialUrls: true,
      isVerified: true, isOpenToOpportunities: true, isBanned: true, safetyRestrictedUntil: true,
      safetySuspendedUntil: true, webDiscoveryEnabled: true, aiDiscoveryEnabled: true, shareLocationPublic: true,
      currentCity: true, currentState: true, currentCountry: true, lastActiveAt: true, updatedAt: true,
      skills: { select: { skill: { select: { name: true } } }, take: 50 },
      experiences: { orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }] },
      educationHistory: { orderBy: [{ isCurrent: 'desc' }, { startDate: 'desc' }] },
      projects: { orderBy: [{ featured: 'desc' }, { startDate: 'desc' }] },
      certificates: { orderBy: { issueDate: 'desc' } },
      achievements: { orderBy: { date: 'desc' } },
      posts: {
        where: { visibility: 'public', isActive: true, type: 'text', content: { not: '' } },
        orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, content: true, likesCount: true, commentsCount: true, sharesCount: true, createdAt: true },
      },
      _count: { select: { experiences: true, educationHistory: true, projects: true, certificates: true, achievements: true, posts: { where: { visibility: 'public', isActive: true, type: 'text', content: { not: '' } } } } },
    },
  });
  if (!user || !isPublicUserEligible(user, channel)) return null;
  const location = user.shareLocationPublic === true
    ? [user.currentCity, user.currentState, user.currentCountry].map((part) => normalizeDiscoveryText(part, 80)).filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(', ') || null
    : null;
  return {
    username: user.username, name: user.name, headline: user.headline, bio: user.bio, avatar: user.profileImage,
    skills: user.skills.map((entry) => entry.skill.name), interests: user.interests, location,
    profileUrl: `${WEB_BASE_URL}/people/${encodeURIComponent(user.username)}`, verified: user.isVerified,
    openToOpportunities: user.isOpenToOpportunities,
    bannerImage: user.bannerImageUrl,
    college: user.college,
    branch: user.branch,
    degree: user.degree,
    graduationYear: user.graduationYear,
    portfolioUrl: user.portfolioUrl,
    linkedinUrl: user.linkedinUrl,
    githubProfileUrl: user.githubProfileUrl,
    otherSocialUrls: user.otherSocialUrls,
    experiences: user.experiences.map((entry) => ({ title: entry.title, company: entry.company, type: entry.type,
      location: entry.location, startDate: entry.startDate.toISOString(), endDate: entry.endDate?.toISOString() || null,
      current: entry.isCurrent, description: entry.description, skills: entry.skills, logo: entry.logo })),
    education: user.educationHistory.map((entry) => ({ school: entry.school, degree: entry.degree, fieldOfStudy: entry.fieldOfStudy,
      startDate: entry.startDate.toISOString(), endDate: entry.endDate?.toISOString() || null, current: entry.isCurrent,
      grade: entry.grade, activities: entry.activities, description: entry.description, logo: entry.logo })),
    projects: user.projects.map((entry) => ({ id: entry.id, title: entry.name, description: entry.description,
      url: entry.projectUrl, role: entry.role,
      techStack: entry.techStack, startDate: entry.startDate.toISOString(), endDate: entry.endDate?.toISOString() || null,
      current: entry.isCurrent, projectUrl: entry.projectUrl, githubUrl: entry.githubUrl, otherLinks: entry.otherLinks,
      images: entry.images, featured: entry.featured })),
    certificates: user.certificates.map((entry) => ({ name: entry.name, issuingOrganization: entry.issuingOrg,
      issueDate: entry.issueDate.toISOString(), expiryDate: entry.expiryDate?.toISOString() || null,
      doesNotExpire: entry.doesNotExpire, credentialId: entry.credentialId, credentialUrl: entry.credentialUrl })),
    achievements: user.achievements.map((entry) => ({ title: entry.title, type: entry.type, organization: entry.organization,
      date: entry.date.toISOString(), description: entry.description, certificateUrl: entry.certificateUrl })),
    publicTextPosts: user.posts.map((post) => ({ id: post.id, content: post.content.slice(0, 4_000),
      url: `${WEB_BASE_URL}/post/${post.id}`, likesCount: post.likesCount, commentsCount: post.commentsCount,
      sharesCount: post.sharesCount, createdAt: post.createdAt.toISOString() })),
    sectionCounts: { experiences: user._count.experiences, education: user._count.educationHistory,
      projects: user._count.projects, certificates: user._count.certificates, achievements: user._count.achievements,
      publicTextPosts: user._count.posts },
    indexable: user.webDiscoveryEnabled && Boolean(user.headline || user.bio || user.interests.length || user.skills.length || user.projects.length),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function updateDiscoveryVisibility(userId: string, input: { webDiscoveryEnabled?: boolean; aiDiscoveryEnabled?: boolean }) {
  const data: { webDiscoveryEnabled?: boolean; aiDiscoveryEnabled?: boolean; discoveryVisibilityUpdatedAt: Date } = {
    discoveryVisibilityUpdatedAt: new Date(),
  };
  if (typeof input.webDiscoveryEnabled === 'boolean') data.webDiscoveryEnabled = input.webDiscoveryEnabled;
  if (typeof input.aiDiscoveryEnabled === 'boolean') data.aiDiscoveryEnabled = input.aiDiscoveryEnabled;
  const user = await prismaWrite.user.update({
    where: { id: userId },
    data,
    select: { id: true, username: true, webDiscoveryEnabled: true, aiDiscoveryEnabled: true, discoveryVisibilityUpdatedAt: true },
  });
  await reindexPublicProfile(userId).catch(() => undefined);
  return user;
}

export async function getDiscoveryVisibility(userId: string) {
  return prismaRead.user.findUnique({
    where: { id: userId },
    select: { webDiscoveryEnabled: true, aiDiscoveryEnabled: true, discoveryVisibilityUpdatedAt: true },
  });
}

export async function reindexPublicProfile(userId: string): Promise<void> {
  const user = await prismaRead.user.findUnique({
    where: { id: userId },
    select: {
      id: true, username: true, name: true, headline: true, bio: true, interests: true, college: true, branch: true,
      isBanned: true, safetyRestrictedUntil: true, safetySuspendedUntil: true, webDiscoveryEnabled: true, aiDiscoveryEnabled: true,
      skills: { select: { skill: { select: { name: true } } } },
    },
  });
  if (!user) return;
  const eligible = isPublicUserEligible(user, 'ai');
  const publicText = [user.name, user.username, user.headline, user.bio, user.college, user.branch,
    ...user.interests, ...user.skills.map((entry) => entry.skill.name)].filter(Boolean).join(' ');
  const contentHash = createHash('sha256').update(publicText).digest('hex');
  const embedding = eligible && publicText.trim() ? await createEmbedding(publicText) : null;
  const metadata = JSON.stringify({ username: user.username, skills: user.skills.map((entry) => entry.skill.name), interests: user.interests });
  await prismaWrite.$executeRawUnsafe(
    `INSERT INTO "discovery_documents"
       ("id", "entityType", "entityId", "ownerId", "canonicalUrl", "publicText", "metadata", "contentHash", "eligibilityStatus", "embedding", "updatedAt")
     VALUES ($1, 'profile', $2, $2, $3, $4, $5::jsonb, $6, $7, $8::vector, CURRENT_TIMESTAMP)
     ON CONFLICT ("entityType", "entityId") DO UPDATE SET
       "canonicalUrl" = EXCLUDED."canonicalUrl", "publicText" = EXCLUDED."publicText", "metadata" = EXCLUDED."metadata",
       "contentHash" = EXCLUDED."contentHash", "eligibilityStatus" = EXCLUDED."eligibilityStatus",
       "embedding" = EXCLUDED."embedding", "updatedAt" = CURRENT_TIMESTAMP`,
    `profile:${user.id}`,
    user.id,
    `${WEB_BASE_URL}/people/${encodeURIComponent(user.username)}`,
    publicText,
    metadata,
    contentHash,
    eligible ? 'eligible' : 'excluded',
    embedding ? vectorLiteral(embedding) : null
  );
  void submitIndexNow([`${WEB_BASE_URL}/people/${encodeURIComponent(user.username)}`]);
}

export async function searchPublicOpportunities(query: string, types: string[] = [], limit = 8): Promise<PublicOpportunityResult[]> {
  if (process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return [];
  const normalized = normalizeDiscoveryText(query).toLowerCase();
  const requestedTypes = new Set(normalizeDiscoveryList(types));
  const max = Math.min(10, Math.max(1, Number(limit) || 8));
  const terms = (normalized.match(/[a-z0-9+#.]{2,}/g) || []).slice(0, 12);
  const matches = (text: string) => !terms.length || terms.some((term) => text.toLowerCase().includes(term));
  const output: PublicOpportunityResult[] = [];

  if (!requestedTypes.size || requestedTypes.has('job')) {
    for (const job of growthJobs) {
      const text = [job.title, job.description, job.location, job.experienceLevel, ...job.skills].join(' ');
      if (matches(text)) output.push({ id: job.id, type: 'job', title: job.title, description: job.description,
        url: `${WEB_BASE_URL}/jobs/${job.slug}`, location: job.location, skills: job.skills });
    }
  }
  if (!requestedTypes.size || requestedTypes.has('learning')) {
    for (const path of learningPaths) {
      const text = [path.title, path.description, path.category, path.difficulty].join(' ');
      if (matches(text)) output.push({ id: path.id, type: 'learning', title: path.title, description: path.description,
        url: `${WEB_BASE_URL}/learning/${path.slug}`, location: null, skills: [path.category] });
    }
  }

  if (output.length < max && (!requestedTypes.size || requestedTypes.has('group'))) {
    const groups = await prismaRead.groups.findMany({
      where: { isPrivate: false, ...(terms.length ? { OR: terms.flatMap((term) => [
        { name: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
        { tags: { has: term } },
      ]) } : {}) },
      take: max,
      orderBy: [{ memberCount: 'desc' }, { updatedAt: 'desc' }],
    });
    output.push(...groups.map((group) => ({ id: group.id, type: 'group' as const, title: group.name,
      description: group.description || 'Public Vormex group', url: `${WEB_BASE_URL}/groups/${group.slug || group.id}`,
      location: null, skills: group.tags })));
  }

  if (output.length < max && (!requestedTypes.size || requestedTypes.has('hackathon'))) {
    const hackathons = await prismaRead.hackathons.findMany({
      where: { isActive: true, status: 'active', ...(terms.length ? { OR: terms.flatMap((term) => [
        { title: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
        { skills: { has: term } },
        { tags: { has: term } },
      ]) } : {}) },
      take: max,
      orderBy: { startsAt: 'asc' },
    });
    output.push(...hackathons.map((item) => ({ id: item.id, type: 'hackathon' as const, title: item.title,
      description: item.description, url: `${WEB_BASE_URL}/hackathons/${item.slug}`, location: item.location,
      skills: item.skills, startsAt: item.startsAt.toISOString() })));
  }

  if (output.length < max && (!requestedTypes.size || requestedTypes.has('event'))) {
    const events = await prismaRead.campus_events.findMany({
      where: { startsAt: { gte: new Date() }, ...(terms.length ? { OR: terms.flatMap((term) => [
        { title: { contains: term, mode: 'insensitive' as const } },
        { description: { contains: term, mode: 'insensitive' as const } },
        { campus: { contains: term, mode: 'insensitive' as const } },
        { tags: { has: term } },
      ]) } : {}) },
      take: max,
      orderBy: { startsAt: 'asc' },
    });
    output.push(...events.map((item) => ({ id: item.id, type: 'event' as const, title: item.title,
      description: item.description, url: `${WEB_BASE_URL}/events/${item.id}`, location: item.campus,
      skills: item.tags, startsAt: item.startsAt.toISOString() })));
  }

  return output.slice(0, max);
}

export async function listIndexableProfiles(limit = 5_000, cursor?: string) {
  return prismaRead.user.findMany({
    where: {
      webDiscoveryEnabled: true,
      isBanned: false,
      AND: [
        { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lte: new Date() } }] },
        { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lte: new Date() } }] },
        { OR: [
          { headline: { not: null } }, { bio: { not: null } }, { interests: { isEmpty: false } }, { skills: { some: {} } },
        ] },
      ],
    },
    take: Math.min(5_000, Math.max(1, limit)),
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { id: 'asc' },
    select: { id: true, username: true, updatedAt: true },
  });
}
