import { PrismaClient } from '@prisma/client';
import { dbConnectionGauge } from '../infrastructure/metrics/registry';
import { assertDatabasePoolConfig, buildDatabasePoolConfig } from './database-url.util';

type PrismaGlobal = {
  prismaWrite?: PrismaClient;
  prismaRead?: PrismaClient;
};

const globalForPrisma = global as unknown as PrismaGlobal;

function buildClient(logQueries = false, url?: string): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? logQueries
          ? ['query', 'error', 'warn']
          : ['error', 'warn']
        : ['error'],
    ...(url
      ? {
          datasources: {
            db: {
              url,
            },
          },
        }
      : {}),
  });
}

const logQueries = process.env.PRISMA_LOG_QUERIES === 'true';
const writePoolConfig = buildDatabasePoolConfig({ env: process.env, role: 'write' });
const readPoolConfig = buildDatabasePoolConfig({ env: process.env, role: 'read' });

assertDatabasePoolConfig(
  readPoolConfig.isConfigured ? [writePoolConfig, readPoolConfig] : [writePoolConfig],
  process.env
);

for (const warning of [...writePoolConfig.warnings, ...readPoolConfig.warnings]) {
  console.warn(`[database-pool] ${warning}`);
}

export const prismaWrite =
  globalForPrisma.prismaWrite || buildClient(logQueries, writePoolConfig.url);

const readUrl = readPoolConfig.url;
export const prismaRead =
  globalForPrisma.prismaRead ||
  (readUrl && readUrl !== writePoolConfig.url
    ? buildClient(logQueries, readUrl)
    : prismaWrite);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaWrite = prismaWrite;
  globalForPrisma.prismaRead = prismaRead;
}

export const prisma = prismaWrite;

/**
 * Opt a read into fetching its relations with a database join instead of one
 * extra round trip per relation.
 *
 * Prisma's default strategy issues a separate query per `include`, so a post
 * read with six included relations costs seven round trips to Neon. Joining is
 * the right call **only** when the included relations cannot multiply rows —
 * to-one relations, and to-many relations already filtered down to the viewer
 * (`likes`, `saved_posts` and `pollVotes` are all scoped to one user id, so they
 * return at most one row each). Do not spread this into a read that includes an
 * unbounded to-many relation: the join would repeat the parent row per child.
 *
 * Set PRISMA_RELATION_JOINS=false to fall back without a code change.
 */
/*
 * Exposed as a bare value assigned to an explicit `relationLoadStrategy:` key
 * rather than as a spreadable object. Spreading into Prisma's generated
 * argument types makes the checker relate the whole spread result against a
 * 140-model schema at every call site, which overflows its stack.
 */
export const JOIN_RELATIONS: 'join' | 'query' =
  process.env.PRISMA_RELATION_JOINS === 'false' ? 'query' : 'join';

export async function disconnectPrisma(): Promise<void> {
  await Promise.allSettled([
    prismaWrite.$disconnect(),
    prismaRead === prismaWrite ? Promise.resolve() : prismaRead.$disconnect(),
  ]);
}

export async function collectDbConnectionMetrics(): Promise<void> {
  try {
    const rows = await prismaWrite.$queryRaw<Array<{ state: string | null; count: bigint | number }>>`
      SELECT COALESCE(state, 'unknown') AS state, COUNT(*) AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY COALESCE(state, 'unknown')
    `;

    dbConnectionGauge.reset();
    for (const row of rows) {
      dbConnectionGauge.set({ state: row.state || 'unknown' }, Number(row.count));
    }
  } catch {
    // Some managed hosts restrict pg_stat_activity details. Metrics should not break /metrics.
  }
}
