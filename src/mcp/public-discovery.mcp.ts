import type { Express, NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { createRateLimitMiddleware } from '../middleware/rate-limit.middleware';
import {
  getPublicProfile,
  searchPublicOpportunities,
  searchPublicPeople,
} from '../services/public-discovery.service';
import {
  getPublicPost,
  listPublicProfilePosts,
  searchAllPublicVormex,
  searchPublicPosts,
} from '../services/public-content-discovery.service';
import {
  MCP_APP_MIME_TYPE,
  PROFILE_CARDS_HTML,
  PROFILE_CARDS_RESOURCE_URI,
} from './profile-cards.widget';

const MCP_PATH = '/mcp';
export const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
const LOCAL_OPENAI_APPS_CHALLENGE_TOKEN = 'local-openai-apps-challenge';

export function getOpenAiAppsChallengeToken(): string {
  const configuredToken = process.env.OPENAI_APPS_CHALLENGE_TOKEN?.trim();
  if (configuredToken) return configuredToken;
  return process.env.NODE_ENV === 'production' ? '' : LOCAL_OPENAI_APPS_CHALLENGE_TOKEN;
}
const mcpRateLimit = createRateLimitMiddleware(() => [
  { keyPrefix: 'mcp:search:ip', limit: 60, windowSeconds: 60, code: 'MCP_RATE_LIMITED' },
]);
const profileCardsToolMeta = {
  ui: { resourceUri: PROFILE_CARDS_RESOURCE_URI },
  'openai/outputTemplate': PROFILE_CARDS_RESOURCE_URI,
  'openai/toolInvocation/invoking': 'Finding public Vormex profiles',
  'openai/toolInvocation/invoked': 'Vormex profiles ready',
};

export const publicDiscoveryToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const nullableString = z.string().nullable();
const publicPersonSchema = z.object({
  username: z.string(),
  name: z.string(),
  headline: nullableString,
  bio: nullableString,
  avatar: nullableString,
  skills: z.array(z.string()),
  interests: z.array(z.string()),
  location: nullableString,
  profileUrl: z.string(),
  verified: z.boolean(),
  openToOpportunities: z.boolean(),
  matchScore: z.number(),
  matchScoreBand: z.enum(['strong', 'good', 'related']),
  matchReasons: z.array(z.string()),
});

const publicProfileSchema = z.object({
  username: z.string(),
  name: z.string(),
  headline: nullableString,
  bio: nullableString,
  avatar: nullableString,
  skills: z.array(z.string()),
  interests: z.array(z.string()),
  location: nullableString,
  profileUrl: z.string(),
  verified: z.boolean(),
  openToOpportunities: z.boolean(),
  bannerImage: nullableString,
  connectionsCount: z.number().int().nonnegative(),
  college: nullableString,
  branch: nullableString,
  degree: nullableString,
  graduationYear: z.number().int().nullable(),
  portfolioUrl: nullableString,
  linkedinUrl: nullableString,
  githubProfileUrl: nullableString,
  otherSocialUrls: z.unknown().nullable(),
  experiences: z.array(z.object({
    title: z.string(),
    company: z.string(),
    type: z.string(),
    location: nullableString,
    startDate: z.string(),
    endDate: nullableString,
    current: z.boolean(),
    description: nullableString,
    skills: z.array(z.string()),
    logo: nullableString,
  })),
  education: z.array(z.object({
    school: z.string(),
    degree: z.string(),
    fieldOfStudy: z.string(),
    startDate: z.string(),
    endDate: nullableString,
    current: z.boolean(),
    grade: nullableString,
    activities: nullableString,
    description: nullableString,
    logo: nullableString,
  })),
  projects: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    url: nullableString,
    role: nullableString,
    techStack: z.array(z.string()),
    startDate: z.string(),
    endDate: nullableString,
    current: z.boolean(),
    projectUrl: nullableString,
    githubUrl: nullableString,
    otherLinks: z.unknown().nullable(),
    images: z.array(z.string()),
    featured: z.boolean(),
  })),
  certificates: z.array(z.object({
    name: z.string(),
    issuingOrganization: z.string(),
    issueDate: z.string(),
    expiryDate: nullableString,
    doesNotExpire: z.boolean(),
    credentialId: nullableString,
    credentialUrl: nullableString,
  })),
  achievements: z.array(z.object({
    title: z.string(),
    type: z.string(),
    organization: z.string(),
    date: z.string(),
    description: nullableString,
    certificateUrl: nullableString,
  })),
  publicTextPosts: z.array(z.object({
    id: z.string(),
    content: z.string(),
    url: z.string(),
    likesCount: z.number().int().nonnegative(),
    commentsCount: z.number().int().nonnegative(),
    sharesCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })),
  sectionCounts: z.object({
    experiences: z.number().int().nonnegative(),
    education: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative(),
    certificates: z.number().int().nonnegative(),
    achievements: z.number().int().nonnegative(),
    publicTextPosts: z.number().int().nonnegative(),
  }),
  indexable: z.boolean(),
  updatedAt: z.string(),
});

const publicPostSchema = z.object({
  id: z.string(),
  content: z.string(),
  contentTruncated: z.boolean(),
  url: z.string(),
  author: z.object({
    username: z.string(),
    name: z.string(),
    headline: nullableString,
    avatar: nullableString,
    profileUrl: z.string(),
  }),
  engagement: z.object({
    likes: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    shares: z.number().int().nonnegative(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  matchReasons: z.array(z.string()),
});

const publicOpportunitySchema = z.object({
  id: z.string(),
  type: z.enum(['job', 'learning', 'group', 'event', 'hackathon']),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  location: nullableString,
  skills: z.array(z.string()),
  startsAt: nullableString.optional(),
});

async function resolvePublicProfile(identifier: string) {
  const direct = await getPublicProfile(identifier, 'ai');
  if (direct) return direct;
  const normalized = identifier.replace(/^@/, '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;
  const candidates = await searchPublicPeople({ goal: identifier, limit: 10 });
  const exact = candidates.find((candidate) => candidate.username.toLowerCase() === normalized || candidate.name.trim().replace(/\s+/g, ' ').toLowerCase() === normalized);
  return exact ? getPublicProfile(exact.username, 'ai') : null;
}

export function mcpCorsHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  next();
}

export function createPublicDiscoveryMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'vormex-public-discovery', version: '3.0.0' },
    {
      instructions:
        'Search Vormex public profiles, public text posts, jobs, learning resources, groups, events, and hackathons. When the user names one particular person or username and asks for that profile, always call get_public_vormex_profile and return exactly that one profile card. For recommendations or discovery of multiple people, call find_public_people_for_goal and respect an explicitly requested count from 1 to 10; use 5 only when no count is requested. Do not fetch every recommendation again because the people tool already returns full eligible profiles and a card carousel. Keep written responses brief instead of restating every card. Use search_public_vormex only for broad content requests that are not specifically asking for people. Results contain eligible public data only: never infer or request chats, private content, contact details, precise location, or other sensitive fields.',
    }
  );

  server.registerResource(
    'vormex-profile-cards',
    PROFILE_CARDS_RESOURCE_URI,
    {
      title: 'Vormex public profile cards',
      description: 'Visual cards for eligible public Vormex member results.',
      mimeType: MCP_APP_MIME_TYPE,
    },
    async () => ({
      contents: [{
        uri: PROFILE_CARDS_RESOURCE_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: PROFILE_CARDS_HTML,
        _meta: {
          ui: {
            prefersBorder: false,
            domain: 'https://www.vormex.in',
            csp: {
              connectDomains: [],
              resourceDomains: [
                'https://api.dicebear.com',
                'https://lh3.googleusercontent.com',
                'https://vormex.b-cdn.net',
                'https://vormex-backend.onrender.com',
                'https://www.vormex.in',
              ],
            },
          },
          'openai/widgetDescription': 'Shows eligible public Vormex member profiles with cover images, profile pictures, bios, skills, interests, connection totals, and profile links.',
          'openai/widgetPrefersBorder': false,
          'openai/widgetCSP': {
            connect_domains: [],
            resource_domains: [
              'https://api.dicebear.com',
              'https://lh3.googleusercontent.com',
              'https://vormex.b-cdn.net',
              'https://vormex-backend.onrender.com',
              'https://www.vormex.in',
            ],
          },
          'openai/widgetDomain': 'https://www.vormex.in',
        },
      }],
    })
  );

  server.registerTool(
    'search_public_vormex',
    {
      title: 'Search all public Vormex content',
      description:
        'Search across eligible public Vormex text posts, jobs, learning resources, groups, events, and hackathons for a broad topic. Do not use this tool when the user asks to find, show, suggest, recommend, or compare people, members, mentors, learners, or collaborators; use find_public_people_for_goal for those requests.',
      inputSchema: {
        query: z.string().min(2).max(240).describe('The topic, question, skill, goal, event, or opportunity to find on Vormex'),
        sources: z.array(z.enum(['people', 'posts', 'job', 'learning', 'group', 'event', 'hackathon'])).max(7).optional(),
        location: z.string().max(80).optional().describe('Optional coarse city, state, country, or college for people results'),
        limitPerSource: z.number().int().min(1).max(10).optional(),
      },
      outputSchema: {
        query: z.string(),
        people: z.array(publicPersonSchema),
        posts: z.array(publicPostSchema),
        opportunities: z.array(publicOpportunitySchema),
        searchedSources: z.array(z.string()),
        count: z.number().int().nonnegative(),
      },
      annotations: publicDiscoveryToolAnnotations,
    },
    async (input) => {
      const results = await searchAllPublicVormex(input);
      const count = results.people.length + results.posts.length + results.opportunities.length;
      return {
        structuredContent: { ...results, count },
        content: [{
          type: 'text' as const,
          text: count
            ? `Found ${count} eligible public Vormex results for "${results.query}" across ${results.searchedSources.join(', ')}.`
            : `No eligible public Vormex results matched "${results.query}" yet.`,
        }],
      };
    }
  );

  server.registerTool(
    'find_public_people_for_goal',
    {
      title: 'Find public Vormex people for a goal',
      description:
        'Use for recommendations or discovery of multiple Vormex people, members, mentors, learners, teammates, or collaborators. Respect the number requested by the user from 1 to 10, defaulting to 5 only when no count is stated. For one specifically named person or username, use get_public_vormex_profile instead. Returns complete eligible public profile cards, so do not fetch every result again.',
      inputSchema: {
        goal: z.string().min(2).max(240).describe('What the user wants to learn, build, teach, or collaborate on'),
        skills: z.array(z.string().min(1).max(48)).max(10).optional(),
        interests: z.array(z.string().min(1).max(48)).max(10).optional(),
        location: z.string().max(80).optional().describe('Optional city, state, country, or college'),
        limit: z.number().int().min(1).max(10).optional().describe('Number of people cards requested by the user; defaults to 5 when unspecified'),
      },
      outputSchema: {
        people: z.array(publicPersonSchema),
        profiles: z.array(publicProfileSchema),
        count: z.number().int().nonnegative(),
        goal: z.string(),
        display: z.literal('profile-card-carousel'),
      },
      annotations: publicDiscoveryToolAnnotations,
      _meta: profileCardsToolMeta,
    },
    async (input) => {
      const requestedLimit = Math.min(10, Math.max(1, Number(input.limit) || 5));
      const people = await searchPublicPeople({ ...input, limit: requestedLimit });
      const profiles = (await Promise.all(people.map((person) => getPublicProfile(person.username, 'ai'))))
        .filter((profile) => profile !== null);
      return {
        structuredContent: { people, profiles, count: profiles.length, goal: input.goal, display: 'profile-card-carousel' },
        content: [{
          type: 'text' as const,
          text: people.length
            ? `Showing ${profiles.length} public Vormex ${profiles.length === 1 ? 'member' : 'members'} relevant to "${input.goal}" in the profile card carousel.`
            : `No eligible public Vormex profiles matched "${input.goal}" yet.`,
        }],
      };
    }
  );

  server.registerTool(
    'get_public_vormex_profile',
    {
      title: 'Get a public Vormex profile',
      description: 'Use whenever the user asks for one specifically named Vormex person or username. Resolves an exact public display name or username and returns exactly one comprehensive eligible profile card. It never returns chats, contact details, precise location, or private data.',
      inputSchema: { username: z.string().min(1).max(80).describe('Exact Vormex username, with or without @, or exact public display name') },
      outputSchema: { profile: publicProfileSchema.nullable() },
      annotations: publicDiscoveryToolAnnotations,
      _meta: profileCardsToolMeta,
    },
    async ({ username }) => {
      const profile = await resolvePublicProfile(username);
      return {
        structuredContent: { profile },
        content: [{ type: 'text' as const, text: profile ? `Public Vormex profile for @${profile.username}.` : 'That profile is not available for public AI discovery.' }],
        isError: !profile,
      };
    }
  );

  server.registerTool(
    'search_public_vormex_posts',
    {
      title: 'Search public Vormex text posts',
      description: 'Find eligible public Vormex text posts about a topic such as a hackathon, project, technology, learning goal, announcement, or collaboration request.',
      inputSchema: {
        query: z.string().min(2).max(240),
        limit: z.number().int().min(1).max(10).optional(),
      },
      outputSchema: {
        query: z.string(),
        posts: z.array(publicPostSchema),
        count: z.number().int().nonnegative(),
      },
      annotations: publicDiscoveryToolAnnotations,
    },
    async ({ query, limit }) => {
      const posts = await searchPublicPosts(query, limit);
      return {
        structuredContent: { query, posts, count: posts.length },
        content: [{ type: 'text' as const, text: `Found ${posts.length} eligible public Vormex text posts for "${query}".` }],
      };
    }
  );

  server.registerTool(
    'list_public_vormex_profile_posts',
    {
      title: 'List a member\'s public Vormex posts',
      description: 'Page through all eligible public text posts belonging to one AI-discoverable Vormex member. Use the returned nextCursor to request another page.',
      inputSchema: {
        username: z.string().min(1).max(40).describe('Vormex username, with or without @'),
        limit: z.number().int().min(1).max(20).optional(),
        cursor: z.string().min(1).max(80).optional().describe('nextCursor returned by the previous call'),
      },
      outputSchema: {
        username: z.string(),
        posts: z.array(publicPostSchema),
        nextCursor: nullableString,
        count: z.number().int().nonnegative(),
      },
      annotations: publicDiscoveryToolAnnotations,
    },
    async ({ username, limit, cursor }) => {
      const page = await listPublicProfilePosts(username, limit, cursor);
      return {
        structuredContent: { username: username.replace(/^@/, ''), ...page, count: page.posts.length },
        content: [{ type: 'text' as const, text: `Found ${page.posts.length} eligible public Vormex posts for @${username.replace(/^@/, '')}.` }],
      };
    }
  );

  server.registerTool(
    'get_public_vormex_post',
    {
      title: 'Get a public Vormex text post',
      description: 'Retrieve one eligible public Vormex text post and its public author summary by post ID after a search result needs more detail.',
      inputSchema: { postId: z.string().min(1).max(80).describe('Vormex post ID returned by a search tool') },
      outputSchema: { post: publicPostSchema.nullable() },
      annotations: publicDiscoveryToolAnnotations,
    },
    async ({ postId }) => {
      const post = await getPublicPost(postId);
      return {
        structuredContent: { post },
        content: [{ type: 'text' as const, text: post ? `Public Vormex post by @${post.author.username}.` : 'That post is not available for public AI discovery.' }],
        isError: !post,
      };
    }
  );

  server.registerTool(
    'find_public_vormex_opportunities',
    {
      title: 'Find public Vormex opportunities',
      description: 'Find eligible public Vormex jobs, learning paths, groups, events, and hackathons relevant to a stated goal or skill. Also returns related public text posts so community announcements and discussions are not missed.',
      inputSchema: {
        query: z.string().min(1).max(240),
        types: z.array(z.enum(['job', 'learning', 'group', 'event', 'hackathon'])).max(5).optional(),
        limit: z.number().int().min(1).max(10).optional(),
      },
      outputSchema: {
        opportunities: z.array(publicOpportunitySchema),
        relatedPosts: z.array(publicPostSchema),
        count: z.number().int().nonnegative(),
        query: z.string(),
      },
      annotations: publicDiscoveryToolAnnotations,
    },
    async ({ query, types, limit }) => {
      const [opportunities, relatedPosts] = await Promise.all([
        searchPublicOpportunities(query, types, limit),
        searchPublicPosts(query, limit),
      ]);
      return {
        structuredContent: { opportunities, relatedPosts, count: opportunities.length + relatedPosts.length, query },
        content: [{ type: 'text' as const, text: `Found ${opportunities.length} public Vormex opportunities and ${relatedPosts.length} related public posts for "${query}".` }],
      };
    }
  );

  return server;
}

export function registerPublicDiscoveryMcp(app: Express): void {
  app.get(OPENAI_APPS_CHALLENGE_PATH, (_req: Request, res: Response): void => {
    const challengeToken = getOpenAiAppsChallengeToken();
    if (!challengeToken) {
      res.status(503).type('text/plain').send('Challenge verification is not configured');
      return;
    }
    res.status(200).type('text/plain').send(challengeToken);
  });

  app.all(MCP_PATH, mcpRateLimit, async (req: Request, res: Response): Promise<void> => {
    if (process.env.MCP_ENABLED === 'false') {
      res.status(404).send('Not Found');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'POST, GET, DELETE, OPTIONS');
      res.status(405).send('Method Not Allowed');
      return;
    }
    if (Number(req.headers['content-length'] || 0) > 32 * 1024) {
      res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request too large' }, id: null });
      return;
    }

    const server = createPublicDiscoveryMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Vormex MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
}
