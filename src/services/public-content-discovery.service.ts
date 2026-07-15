import { prismaRead } from '../config/prisma';
import {
  normalizeDiscoveryList,
  normalizeDiscoveryText,
  searchPublicOpportunities,
  searchPublicPeople,
  type PublicOpportunityResult,
  type PublicPersonResult,
} from './public-discovery.service';

const WEB_BASE_URL = (process.env.PUBLIC_WEB_BASE_URL || process.env.FRONTEND_URL || 'https://www.vormex.in')
  .replace(/\/+$/, '')
  .replace('https://vormex.in', 'https://www.vormex.in');

export interface PublicPostResult {
  id: string;
  content: string;
  contentTruncated: boolean;
  url: string;
  author: { username: string; name: string; headline: string | null; avatar: string | null; profileUrl: string };
  engagement: { likes: number; comments: number; shares: number };
  createdAt: string;
  updatedAt: string;
  matchReasons: string[];
}

export interface PublicVormexSearchResult {
  query: string;
  people: PublicPersonResult[];
  posts: PublicPostResult[];
  opportunities: PublicOpportunityResult[];
  searchedSources: string[];
}

export interface PublicPostPage {
  posts: PublicPostResult[];
  nextCursor: string | null;
}

export function tokenizePublicPostQuery(query: string): string[] {
  const normalized = normalizeDiscoveryText(query).toLowerCase();
  const base = normalized.match(/[a-z0-9+#.]{2,}/g) || [];
  const expansions: Record<string, string[]> = {
    hackathon: ['hackathons', 'hack', 'team', 'prize', 'devfolio', 'mlh'],
    hackathons: ['hackathon', 'hack', 'team', 'prize', 'devfolio', 'mlh'],
    code: ['coding', 'programming', 'developer', 'software'],
    coding: ['code', 'programming', 'developer', 'software'],
    job: ['jobs', 'hiring', 'career', 'internship', 'role'],
    mentor: ['mentorship', 'teach', 'guide', 'learn'],
    startup: ['founder', 'entrepreneur', 'business', 'builder'],
  };
  return Array.from(new Set(base.flatMap((token) => [token, ...(expansions[token] || [])]))).slice(0, 24);
}

function publicAuthorEligibility() {
  const now = new Date();
  return {
    isBanned: false,
    aiDiscoveryEnabled: true,
    AND: [
      { OR: [{ safetyRestrictedUntil: null }, { safetyRestrictedUntil: { lte: now } }] },
      { OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lte: now } }] },
    ],
  };
}

function toPublicPost(post: any, tokens: string[]): PublicPostResult {
  const normalizedContent = normalizeDiscoveryText(post.content, 20_000);
  const lower = normalizedContent.toLowerCase();
  const matches = tokens.filter((token) => lower.includes(token));
  const reasons = matches.length ? [`Post discusses ${matches.slice(0, 4).join(', ')}`] : ['Related public text post'];
  if (post.author.isVerified) reasons.push('Written by a verified Vormex member');
  return {
    id: post.id,
    content: normalizedContent.slice(0, 4_000),
    contentTruncated: normalizedContent.length > 4_000,
    url: `${WEB_BASE_URL}/post/${post.id}`,
    author: {
      username: post.author.username,
      name: post.author.name,
      headline: post.author.headline,
      avatar: post.author.profileImage,
      profileUrl: `${WEB_BASE_URL}/people/${encodeURIComponent(post.author.username)}`,
    },
    engagement: { likes: post.likesCount, comments: post.commentsCount, shares: post.sharesCount },
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    matchReasons: reasons,
  };
}

export async function searchPublicPosts(query: string, limit = 8): Promise<PublicPostResult[]> {
  if (process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return [];
  const normalized = normalizeDiscoveryText(query);
  const tokens = tokenizePublicPostQuery(normalized);
  if (!normalized || !tokens.length) return [];
  const max = Math.min(10, Math.max(1, Number(limit) || 8));
  const posts = await prismaRead.post.findMany({
    where: {
      visibility: 'public', isActive: true, type: 'text', content: { not: '' }, author: publicAuthorEligibility(),
      OR: tokens.slice(0, 12).map((token) => ({ content: { contains: token, mode: 'insensitive' as const } })),
    },
    take: 50,
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true, content: true, likesCount: true, commentsCount: true, sharesCount: true, createdAt: true, updatedAt: true,
      author: { select: { username: true, name: true, headline: true, profileImage: true, isVerified: true } },
    },
  });
  return posts
    .map((post) => {
      const lower = post.content.toLowerCase();
      const lexical = tokens.filter((token) => lower.includes(token)).length;
      const ageDays = Math.max(0, (Date.now() - post.createdAt.getTime()) / 86_400_000);
      const recency = Math.exp(-ageDays / 120);
      const engagement = Math.min(1, Math.log1p(post.likesCount + post.commentsCount * 2 + post.sharesCount * 3) / 8);
      return { post: toPublicPost(post, tokens), score: lexical * 10 + recency * 3 + engagement * 2 };
    })
    .sort((left, right) => right.score - left.score || right.post.createdAt.localeCompare(left.post.createdAt))
    .slice(0, max)
    .map(({ post }) => post);
}

export async function getPublicPost(postId: string): Promise<PublicPostResult | null> {
  if (process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return null;
  const id = normalizeDiscoveryText(postId, 80);
  if (!id) return null;
  const post = await prismaRead.post.findFirst({
    where: { id, visibility: 'public', isActive: true, type: 'text', content: { not: '' }, author: publicAuthorEligibility() },
    select: {
      id: true, content: true, likesCount: true, commentsCount: true, sharesCount: true, createdAt: true, updatedAt: true,
      author: { select: { username: true, name: true, headline: true, profileImage: true, isVerified: true } },
    },
  });
  return post ? toPublicPost(post, []) : null;
}

export async function listPublicProfilePosts(username: string, limit = 10, cursor?: string): Promise<PublicPostPage> {
  if (process.env.PUBLIC_AI_DISCOVERY_ENABLED === 'false') return { posts: [], nextCursor: null };
  const normalizedUsername = normalizeDiscoveryText(username.replace(/^@/, ''), 40);
  const normalizedCursor = normalizeDiscoveryText(cursor, 80);
  if (!normalizedUsername) return { posts: [], nextCursor: null };
  const max = Math.min(20, Math.max(1, Number(limit) || 10));
  const posts = await prismaRead.post.findMany({
    where: {
      visibility: 'public', isActive: true, type: 'text', content: { not: '' },
      author: { ...publicAuthorEligibility(), username: { equals: normalizedUsername, mode: 'insensitive' } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: max + 1,
    ...(normalizedCursor ? { cursor: { id: normalizedCursor }, skip: 1 } : {}),
    select: {
      id: true, content: true, likesCount: true, commentsCount: true, sharesCount: true, createdAt: true, updatedAt: true,
      author: { select: { username: true, name: true, headline: true, profileImage: true, isVerified: true } },
    },
  });
  const hasMore = posts.length > max;
  const page = posts.slice(0, max);
  return {
    posts: page.map((post) => toPublicPost(post, [])),
    nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
  };
}

export async function searchAllPublicVormex(input: {
  query: string;
  sources?: string[];
  limitPerSource?: number;
  location?: string;
}): Promise<PublicVormexSearchResult> {
  const query = normalizeDiscoveryText(input.query);
  const sources = new Set(normalizeDiscoveryList(input.sources));
  const all = !sources.size;
  const limit = Math.min(10, Math.max(1, Number(input.limitPerSource) || 5));
  const wantsPeople = all || sources.has('people');
  const wantsPosts = all || sources.has('posts');
  const opportunityTypes = ['job', 'learning', 'group', 'event', 'hackathon'].filter((type) => all || sources.has(type));
  const [people, posts, opportunities] = await Promise.all([
    wantsPeople ? searchPublicPeople({ goal: query, location: input.location, limit }) : Promise.resolve([]),
    wantsPosts ? searchPublicPosts(query, limit) : Promise.resolve([]),
    (all || opportunityTypes.length) ? searchPublicOpportunities(query, opportunityTypes, limit) : Promise.resolve([]),
  ]);
  return {
    query,
    people,
    posts,
    opportunities,
    searchedSources: [wantsPeople && 'people', wantsPosts && 'posts', ...opportunityTypes].filter(Boolean) as string[],
  };
}
