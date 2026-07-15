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
const mcpRateLimit = createRateLimitMiddleware(() => [
  { keyPrefix: 'mcp:search:ip', limit: 60, windowSeconds: 60, code: 'MCP_RATE_LIMITED' },
]);
const profileCardsToolMeta = {
  ui: { resourceUri: PROFILE_CARDS_RESOURCE_URI },
  'openai/outputTemplate': PROFILE_CARDS_RESOURCE_URI,
  'openai/toolInvocation/invoking': 'Finding public Vormex profiles',
  'openai/toolInvocation/invoked': 'Vormex profiles ready',
};

export function mcpCorsHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  next();
}

function createPublicDiscoveryMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'vormex-public-discovery', version: '2.8.0' },
    {
      instructions:
        'Search Vormex public profiles, public text posts, jobs, learning resources, groups, events, and hackathons. For every request to find, show, suggest, recommend, or compare people, members, mentors, learners, or collaborators, always call find_public_people_for_goal directly with a limit from 3 to 10; do not use search_public_vormex and do not fetch every returned profile again. The people tool already returns full eligible profiles and a visual card carousel, so keep the written response brief instead of restating every card. Use search_public_vormex only for broad content requests that are not specifically asking for people. Results contain eligible public data only: never infer or request chats, private content, contact details, precise location, or other sensitive fields. Explain matches using returned evidence and include canonical Vormex links.',
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        'Required tool for any request to find, show, suggest, recommend, or compare Vormex people, members, mentors, learners, teammates, or collaborators. Returns 3 to 10 full eligible public profiles in a visual card carousel. Do not call get_public_vormex_profile for every result because this tool already returns the complete card data.',
      inputSchema: {
        goal: z.string().min(2).max(240).describe('What the user wants to learn, build, teach, or collaborate on'),
        skills: z.array(z.string().min(1).max(48)).max(10).optional(),
        interests: z.array(z.string().min(1).max(48)).max(10).optional(),
        location: z.string().max(80).optional().describe('Optional city, state, country, or college'),
        limit: z.number().int().min(3).max(10).optional().describe('Number of people cards to show; defaults to 5 and must be from 3 to 10'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: profileCardsToolMeta,
    },
    async (input) => {
      const requestedLimit = Math.min(10, Math.max(3, Number(input.limit) || 5));
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
      description: 'Get an eligible member\'s comprehensive public Vormex profile: identity, headline, bio, skills, interests, coarse public location, education, experience, projects, certificates, achievements, and recent public text posts. It never returns chats, contact details, precise location, or private data.',
      inputSchema: { username: z.string().min(1).max(40).describe('Vormex username, with or without @') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: profileCardsToolMeta,
    },
    async ({ username }) => {
      const profile = await getPublicProfile(username, 'ai');
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
