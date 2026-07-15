import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types';
import {
  getDiscoveryVisibility,
  getPublicProfile,
  listIndexableProfiles,
  listPublicPeople,
  normalizeDiscoveryList,
  normalizeDiscoveryText,
  searchPublicOpportunities,
  searchPublicPeople,
  updateDiscoveryVisibility,
} from '../services/public-discovery.service';
import {
  getPublicPost,
  listPublicProfilePosts,
  searchAllPublicVormex,
  searchPublicPosts,
} from '../services/public-content-discovery.service';

export async function searchPeople(req: AuthenticatedRequest, res: Response): Promise<void> {
  const goal = normalizeDiscoveryText(req.body?.goal);
  const skills = normalizeDiscoveryList(req.body?.skills);
  const interests = normalizeDiscoveryList(req.body?.interests);
  if (!goal && !skills.length && !interests.length) {
    res.status(400).json({ error: 'Provide a goal, skill, or interest to search for people.' });
    return;
  }
  const people = await searchPublicPeople({ goal, skills, interests, location: req.body?.location, limit: req.body?.limit });
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.status(200).json({ query: { goal, skills, interests }, people, count: people.length });
}

export async function browsePeople(req: AuthenticatedRequest, res: Response): Promise<void> {
  const goal = normalizeDiscoveryText(req.query.q);
  const people = goal
    ? await searchPublicPeople({ goal, limit: Number(req.query.limit) || 10 }, 'web')
    : await listPublicPeople(Number(req.query.limit) || 24);
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).json({ people, count: people.length });
}

export async function getProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  const profile = await getPublicProfile(String(req.params.username || ''), 'web');
  if (!profile) {
    res.status(404).json({ error: 'Public profile not found' });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).json({ profile });
}

export async function searchOpportunities(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = normalizeDiscoveryText(req.body?.query);
  const opportunities = await searchPublicOpportunities(query, normalizeDiscoveryList(req.body?.types), req.body?.limit);
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).json({ query, opportunities, count: opportunities.length });
}

export async function searchEverything(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = normalizeDiscoveryText(req.body?.query);
  if (!query) { res.status(400).json({ error: 'Provide a query.' }); return; }
  const results = await searchAllPublicVormex({
    query,
    sources: normalizeDiscoveryList(req.body?.sources),
    location: req.body?.location,
    limitPerSource: req.body?.limitPerSource,
  });
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.status(200).json(results);
}

export async function searchPosts(req: AuthenticatedRequest, res: Response): Promise<void> {
  const query = normalizeDiscoveryText(req.body?.query);
  if (!query) { res.status(400).json({ error: 'Provide a query.' }); return; }
  const posts = await searchPublicPosts(query, req.body?.limit);
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.status(200).json({ query, posts, count: posts.length });
}

export async function getPost(req: AuthenticatedRequest, res: Response): Promise<void> {
  const post = await getPublicPost(String(req.params.postId || ''));
  if (!post) { res.status(404).json({ error: 'Public post not found' }); return; }
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.status(200).json({ post });
}

export async function listProfilePosts(req: AuthenticatedRequest, res: Response): Promise<void> {
  const username = String(req.params.username || '');
  const page = await listPublicProfilePosts(
    username,
    Number(req.query.limit) || 10,
    typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  );
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  res.status(200).json({ username: username.replace(/^@/, ''), ...page, count: page.posts.length });
}

export async function sitemapProfiles(req: AuthenticatedRequest, res: Response): Promise<void> {
  const profiles = await listIndexableProfiles(Number(req.query.limit) || 5_000, typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.status(200).json({
    profiles: profiles.map((profile) => ({ username: profile.username, updatedAt: profile.updatedAt.toISOString() })),
    nextCursor: profiles.length === 5_000 ? profiles[profiles.length - 1].id : null,
  });
}

export async function readMyVisibility(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = String(req.user?.userId || '');
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const visibility = await getDiscoveryVisibility(userId);
  res.status(200).json({ visibility });
}

export async function writeMyVisibility(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = String(req.user?.userId || '');
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const web = req.body?.webDiscoveryEnabled;
  const ai = req.body?.aiDiscoveryEnabled;
  if (typeof web !== 'boolean' && typeof ai !== 'boolean') {
    res.status(400).json({ error: 'Provide webDiscoveryEnabled or aiDiscoveryEnabled.' });
    return;
  }
  const visibility = await updateDiscoveryVisibility(userId, { webDiscoveryEnabled: web, aiDiscoveryEnabled: ai });
  res.status(200).json({ visibility });
}

export function publicDiscoveryOpenApi(_req: AuthenticatedRequest, res: Response): void {
  const personSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'name', 'profileUrl', 'skills', 'interests'],
    properties: {
      username: { type: 'string' }, name: { type: 'string' }, headline: { type: ['string', 'null'] },
      bio: { type: ['string', 'null'] }, avatar: { type: ['string', 'null'], format: 'uri' },
      skills: { type: 'array', items: { type: 'string' } }, interests: { type: 'array', items: { type: 'string' } },
      location: { type: ['string', 'null'] }, profileUrl: { type: 'string', format: 'uri' }, verified: { type: 'boolean' },
      openToOpportunities: { type: 'boolean' }, matchScore: { type: 'integer', minimum: 0, maximum: 100 },
      matchScoreBand: { type: 'string', enum: ['strong', 'good', 'related'] },
      matchReasons: { type: 'array', items: { type: 'string' } },
    },
  };
  const peopleInput = {
    type: 'object', additionalProperties: false,
    properties: {
      goal: { type: 'string', maxLength: 240 }, skills: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 48 } },
      interests: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 48 } },
      location: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    },
    anyOf: [{ required: ['goal'] }, { required: ['skills'] }, { required: ['interests'] }],
  };
  const datedSection = (properties: object) => ({
    type: 'array', items: { type: 'object', additionalProperties: true, properties },
  });
  const postSchema = {
    type: 'object', additionalProperties: false,
    required: ['id', 'content', 'url', 'author', 'engagement', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' }, content: { type: 'string' }, contentTruncated: { type: 'boolean' },
      url: { type: 'string', format: 'uri' },
      author: { type: 'object', additionalProperties: false, required: ['username', 'name', 'profileUrl'], properties: {
        username: { type: 'string' }, name: { type: 'string' }, headline: { type: ['string', 'null'] },
        avatar: { type: ['string', 'null'] }, profileUrl: { type: 'string', format: 'uri' },
      } },
      engagement: { type: 'object', properties: { likes: { type: 'integer' }, comments: { type: 'integer' }, shares: { type: 'integer' } } },
      createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
      matchReasons: { type: 'array', items: { type: 'string' } },
    },
  };
  const profileSchema = {
    type: 'object', additionalProperties: false,
    required: [...personSchema.required, 'experiences', 'education', 'projects', 'certificates', 'achievements', 'publicTextPosts', 'sectionCounts'],
    properties: {
      ...personSchema.properties,
      bannerImage: { type: ['string', 'null'] }, college: { type: ['string', 'null'] }, branch: { type: ['string', 'null'] },
      degree: { type: ['string', 'null'] }, graduationYear: { type: ['integer', 'null'] },
      portfolioUrl: { type: ['string', 'null'] }, linkedinUrl: { type: ['string', 'null'] }, githubProfileUrl: { type: ['string', 'null'] },
      otherSocialUrls: {},
      experiences: datedSection({ title: { type: 'string' }, company: { type: 'string' }, type: { type: 'string' }, description: { type: ['string', 'null'] }, skills: { type: 'array', items: { type: 'string' } } }),
      education: datedSection({ school: { type: 'string' }, degree: { type: 'string' }, fieldOfStudy: { type: 'string' }, description: { type: ['string', 'null'] } }),
      projects: datedSection({ id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, techStack: { type: 'array', items: { type: 'string' } }, projectUrl: { type: ['string', 'null'] }, githubUrl: { type: ['string', 'null'] }, images: { type: 'array', items: { type: 'string' } } }),
      certificates: datedSection({ name: { type: 'string' }, issuingOrganization: { type: 'string' }, credentialUrl: { type: ['string', 'null'] } }),
      achievements: datedSection({ title: { type: 'string' }, type: { type: 'string' }, organization: { type: 'string' }, description: { type: ['string', 'null'] } }),
      publicTextPosts: { type: 'array', items: { type: 'object', additionalProperties: true } },
      sectionCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      indexable: { type: 'boolean' }, updatedAt: { type: 'string', format: 'date-time' },
    },
  };
  const jsonBody = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
  const jsonResponse = (description: string, schema: object) => ({ description, content: { 'application/json': { schema } } });
  res.status(200).json({
    openapi: '3.1.0',
    info: { title: 'Vormex Public Discovery API', version: '2.0.0', description: 'Read-only discovery across eligible public Vormex profiles, text posts, and opportunities. Chats, private content, contact details, precise location, and sensitive fields are excluded.' },
    servers: [{ url: process.env.PUBLIC_API_BASE_URL || 'https://vormex-backend.onrender.com' }],
    paths: {
      '/api/public/discovery/search': { post: {
        operationId: 'searchPublicVormex', summary: 'Search all eligible public Vormex people, posts, and opportunities',
        requestBody: jsonBody({ type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 240 }, sources: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['people', 'posts', 'job', 'learning', 'group', 'event', 'hackathon'] } }, location: { type: 'string', maxLength: 80 }, limitPerSource: { type: 'integer', minimum: 1, maximum: 10 } } }),
        responses: { '200': { description: 'Eligible public Vormex results' }, '400': { description: 'Invalid search input' }, '429': { description: 'Rate limited' } },
      } },
      '/api/public/discovery/people/search': { post: {
        operationId: 'findPublicPeopleForGoal', summary: 'Find public Vormex people for a learning, mentoring, or collaboration goal',
        requestBody: jsonBody(peopleInput),
        responses: {
          '200': jsonResponse('Eligible public people', { type: 'object', required: ['people', 'count'], properties: { people: { type: 'array', items: personSchema }, count: { type: 'integer' } } }),
          '400': { description: 'Invalid search input' }, '429': { description: 'Rate limited' },
        },
      } },
      '/api/public/discovery/profiles/{username}': { get: {
        operationId: 'getPublicVormexProfile', summary: 'Get one public Vormex profile',
        parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string', maxLength: 40 } }],
        responses: { '200': jsonResponse('Eligible comprehensive public profile', { type: 'object', required: ['profile'], properties: { profile: profileSchema } }), '404': { description: 'Profile unavailable' }, '429': { description: 'Rate limited' } },
      } },
      '/api/public/discovery/opportunities/search': { post: {
        operationId: 'findPublicVormexOpportunities', summary: 'Find public jobs, learning paths, groups, events, and hackathons',
        requestBody: jsonBody({ type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', maxLength: 240 }, types: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['job', 'learning', 'group', 'event', 'hackathon'] } }, limit: { type: 'integer', minimum: 1, maximum: 10 } } }),
        responses: { '200': { description: 'Eligible public opportunities' }, '429': { description: 'Rate limited' } },
      } },
      '/api/public/discovery/posts/search': { post: {
        operationId: 'searchPublicVormexPosts', summary: 'Search eligible public Vormex text posts',
        requestBody: jsonBody({ type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 240 }, limit: { type: 'integer', minimum: 1, maximum: 10 } } }),
        responses: { '200': jsonResponse('Eligible public text posts', { type: 'object', properties: { posts: { type: 'array', items: postSchema }, count: { type: 'integer' } } }), '400': { description: 'Invalid search input' }, '429': { description: 'Rate limited' } },
      } },
      '/api/public/discovery/posts/{postId}': { get: {
        operationId: 'getPublicVormexPost', summary: 'Get one eligible public Vormex text post',
        parameters: [{ name: 'postId', in: 'path', required: true, schema: { type: 'string', maxLength: 80 } }],
        responses: { '200': jsonResponse('Eligible public text post', { type: 'object', properties: { post: postSchema } }), '404': { description: 'Post unavailable' }, '429': { description: 'Rate limited' } },
      } },
      '/api/public/discovery/profiles/{username}/posts': { get: {
        operationId: 'listPublicVormexProfilePosts', summary: 'Page through one member\'s eligible public Vormex text posts',
        parameters: [
          { name: 'username', in: 'path', required: true, schema: { type: 'string', maxLength: 40 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
          { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 80 } },
        ],
        responses: { '200': jsonResponse('A page of eligible public text posts', { type: 'object', properties: { posts: { type: 'array', items: postSchema }, nextCursor: { type: ['string', 'null'] }, count: { type: 'integer' } } }), '429': { description: 'Rate limited' } },
      } },
    },
  });
}
