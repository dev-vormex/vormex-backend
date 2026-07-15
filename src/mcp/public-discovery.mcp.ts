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

const MCP_PATH = '/mcp';
const mcpRateLimit = createRateLimitMiddleware(() => [
  { keyPrefix: 'mcp:search:ip', limit: 60, windowSeconds: 60, code: 'MCP_RATE_LIMITED' },
]);

export function mcpCorsHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  next();
}

function createPublicDiscoveryMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'vormex-public-discovery', version: '1.0.0' },
    {
      instructions:
        'Use Vormex to find public learners, mentors, builders, collaborators, groups, jobs, hackathons, and learning paths. Results contain public data only. Explain why a result matches the user goal and link to its canonical Vormex page.',
    }
  );

  server.registerTool(
    'find_public_people_for_goal',
    {
      title: 'Find public Vormex people for a goal',
      description:
        'Find public Vormex members relevant to a learning, mentoring, project, startup, skill, or collaboration goal. Use when a user wants people to learn from or build with.',
      inputSchema: {
        goal: z.string().min(2).max(240).describe('What the user wants to learn, build, teach, or collaborate on'),
        skills: z.array(z.string().min(1).max(48)).max(10).optional(),
        interests: z.array(z.string().min(1).max(48)).max(10).optional(),
        location: z.string().max(80).optional().describe('Optional city, state, country, or college'),
        limit: z.number().int().min(1).max(10).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const people = await searchPublicPeople(input);
      return {
        structuredContent: { people, count: people.length, goal: input.goal },
        content: [{
          type: 'text' as const,
          text: people.length
            ? `Found ${people.length} public Vormex ${people.length === 1 ? 'member' : 'members'} relevant to “${input.goal}”.`
            : `No eligible public Vormex profiles matched “${input.goal}” yet.`,
        }],
      };
    }
  );

  server.registerTool(
    'get_public_vormex_profile',
    {
      title: 'Get a public Vormex profile',
      description: 'Retrieve the safe public fields of one Vormex member by username after the user asks for more detail.',
      inputSchema: { username: z.string().min(1).max(40).describe('Vormex username, with or without @') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    'find_public_vormex_opportunities',
    {
      title: 'Find public Vormex opportunities',
      description: 'Find public Vormex jobs, learning paths, groups, events, and hackathons relevant to a stated goal or skill.',
      inputSchema: {
        query: z.string().min(1).max(240),
        types: z.array(z.enum(['job', 'learning', 'group', 'event', 'hackathon'])).max(5).optional(),
        limit: z.number().int().min(1).max(10).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, types, limit }) => {
      const opportunities = await searchPublicOpportunities(query, types, limit);
      return {
        structuredContent: { opportunities, count: opportunities.length, query },
        content: [{ type: 'text' as const, text: `Found ${opportunities.length} public Vormex opportunities for “${query}”.` }],
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
