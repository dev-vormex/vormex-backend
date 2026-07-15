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
  const jsonBody = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
  const jsonResponse = (description: string, schema: object) => ({ description, content: { 'application/json': { schema } } });
  res.status(200).json({
    openapi: '3.1.0',
    info: { title: 'Vormex Public Discovery API', version: '1.0.0', description: 'Read-only public people and opportunity discovery.' },
    servers: [{ url: process.env.PUBLIC_API_BASE_URL || 'https://vormex-backend.onrender.com' }],
    paths: {
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
        responses: { '200': jsonResponse('Eligible public profile', { type: 'object', required: ['profile'], properties: { profile: personSchema } }), '404': { description: 'Profile unavailable' }, '429': { description: 'Rate limited' } },
      } },
      '/api/public/discovery/opportunities/search': { post: {
        operationId: 'findPublicVormexOpportunities', summary: 'Find public jobs, learning paths, groups, events, and hackathons',
        requestBody: jsonBody({ type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', maxLength: 240 }, types: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['job', 'learning', 'group', 'event', 'hackathon'] } }, limit: { type: 'integer', minimum: 1, maximum: 10 } } }),
        responses: { '200': { description: 'Eligible public opportunities' }, '429': { description: 'Rate limited' } },
      } },
    },
  });
}
