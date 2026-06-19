import { PrismaClient } from '@prisma/client';
import { dbConnectionGauge } from '../infrastructure/metrics/registry';
import {
  assertDatabasePoolConfig,
  buildDatabasePoolConfig,
} from './database-url.util';

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

export async function disconnectPrisma(): Promise<void> {
  await Promise.allSettled([
    prismaWrite.$disconnect(),
    prismaRead === prismaWrite ? Promise.resolve() : prismaRead.$disconnect(),
  ]);
}

export async function withWriteTransaction<T>(
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return prismaWrite.$transaction((tx) => fn(tx as unknown as PrismaClient));
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

export const databasePoolConfig = {
  write: writePoolConfig,
  read: readPoolConfig,
};
